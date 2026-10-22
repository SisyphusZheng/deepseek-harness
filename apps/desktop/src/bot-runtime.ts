/** Supervises the optional voice gateway child owned by the WhaleGirlBot desktop shell. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export interface BotRuntimeStatus {
  gateway: boolean
  pid: number | null
  voiceDir: string
  voiceAvailable: boolean
  port: number
  error: string
}

/** The subset of the Bot settings document the shell runtime owns. All fields are optional in storage. */
export interface BotRuntimeConfig {
  voice?: { provider?: string; baseUrl?: string; apiKey?: string; model?: string; voice?: string; wakeWord?: string }
  llm?: { provider?: string; model?: string; baseUrl?: string; apiKey?: string }
  agent?: { mode?: string; workspace?: string; session?: string }
  memory?: { enabled?: boolean }
  approval?: { mode?: string; onceMinutes?: number }
  behavior?: { pauseOnInput?: boolean; allowScreenView?: boolean }
  persona?: {
    name?: string
    personality?: string
    tone?: string
    promptOverride?: string
    background?: string
    quirks?: string
    addressUser?: string
    boundaries?: string
    instructions?: string
  }
}

/** Loopback memory adapter endpoints published to the Host Integration profile layer. */
export interface BotMemoryInfo {
  url: string
  token: string
}

/** Environment variable names each supported LLM provider route reads its key from. */
const LLM_KEY_ENV: Record<string, string> = {
  'opencode-go': 'OPENCODE_GO_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  dashscope: 'DASHSCOPE_API_KEY',
  openai: 'OPENAI_API_KEY',
}

/** Environment variable a custom OpenAI-compatible route reads its key from. */
const CUSTOM_LLM_KEY_ENV = 'WHALEGIRL_LLM_API_KEY'

/** Begin marker of the profile layer this shell owns; the rest of the patch stays user-authored. */
const MANAGED_BEGIN = '# >>> whalegirl-bot: managed profile layer >>>'
/** End marker of the profile layer this shell owns. */
const MANAGED_END = '# <<< whalegirl-bot: managed profile layer <<<'

const DEFAULT_LLM = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }

/**
 * The managed profile patch block: the Bot session's permission boundary, LLM
 * default model, and the first-party Host Integration entry. Everything the
 * user configures elsewhere in the DSH profile is preserved because only this
 * marked block is regenerated.
 */
function managedPatch(
  config: BotRuntimeConfig,
  dshHome: string,
  llmEntry: string,
  hasUserLlmConfig: boolean,
  memory: BotMemoryInfo | null,
): string {
  const provider = String(config.llm?.provider || DEFAULT_LLM.provider).trim() || DEFAULT_LLM.provider
  const model = String(config.llm?.model || DEFAULT_LLM.model).trim() || DEFAULT_LLM.model
  const workspace = String(config.agent?.workspace || '').trim() || join(dshHome, 'workspace')
  const lines = [
    MANAGED_BEGIN,
    '# Regenerated on every start and every Bot settings save. Do not edit by hand.',
    '- id: agent-default-model',
    '  name: "@deepseek-ai/dsh-agent-default-model"',
    '  config:',
    `    provider: ${JSON.stringify(provider)}`,
    `    model: ${JSON.stringify(model)}`,
    '- id: permission',
    '  name: "@deepseek-ai/dsh-permission-presets"',
    '  config:',
    '    presets:',
    '      read-only:',
    '        sandbox: read-only',
    '        approval: ask',
    '      workspace-write:',
    '        sandbox: workspace-write',
    '        approval: ask',
    '      danger-full-access:',
    '        sandbox: danger-full-access',
    '        approval: never',
    '      bot-outside-write:',
    '        sandbox: danger-full-access',
    '        approval: ask',
    '        name: Bot（审批制）',
    '        description: Bot 可操作整个电脑；工作区外写操作在桌宠气泡里逐次审批。',
    '- id: nisse-host-integration',
    '  name: "nisse-host-integration"',
    '  config:',
    `    ipcDir: ${JSON.stringify(join(dshHome, 'nisse'))}`,
    `    workspaceDir: ${JSON.stringify(workspace)}`,
    `    dshLlmEntry: ${JSON.stringify(llmEntry)}`,
    '    permissionPreset: bot-outside-write',
    ...(String(process.env.WHALEGIRL_VOICE_PERSONA_MODULE || '').trim() === '' ? [] : [
      `    voicePersonaModule: ${JSON.stringify(String(process.env.WHALEGIRL_VOICE_PERSONA_MODULE).trim())}`,
    ]),
    ...(memory === null ? [] : [
      `    memoryUrl: ${JSON.stringify(memory.url)}`,
      `    memoryToken: ${JSON.stringify(memory.token)}`,
    ]),
  ]
  if (!hasUserLlmConfig) {
    const keyEnv = LLM_KEY_ENV[provider] ?? CUSTOM_LLM_KEY_ENV
    lines.push(
      '- id: llm-pi-ai',
      '  name: "@deepseek-ai/dsh-llm-pi-ai"',
      '  config:',
      '    providers:',
      `      ${JSON.stringify(provider)}:`,
      `        apiKeyEnv: ${JSON.stringify(keyEnv)}`,
      ...(config.llm?.baseUrl ? [`        baseURL: ${JSON.stringify(String(config.llm.baseUrl))}`] : []),
    )
  }
  lines.push(MANAGED_END)
  return lines.join('\n') + '\n'
}

/** Replace one marked block in a patch file, preserving every line the shell does not own. */
function rewriteManagedBlock(existing: string, block: string): string {
  const begin = existing.indexOf(MANAGED_BEGIN)
  const end = existing.indexOf(MANAGED_END)
  let rest: string
  if (begin >= 0 && end > begin) {
    rest = existing.slice(0, begin) + existing.slice(end + MANAGED_END.length)
  } else {
    rest = existing
  }
  rest = rest.replace(/^\n+/, '').replace(/\n+$/, '')
  const separator = rest.length > 0 ? '\n' : ''
  return `${block}${separator}${rest}${rest.length > 0 ? '\n' : ''}`
}

/** Publish the LLM key the profile's route references into the Host child environment. */
function applyLlmEnvironment(config: BotRuntimeConfig): void {
  const key = String(config.llm?.apiKey || '').trim()
  if (!key) return
  const provider = String(config.llm?.provider || DEFAULT_LLM.provider).trim()
  const envName = LLM_KEY_ENV[provider] ?? CUSTOM_LLM_KEY_ENV
  process.env[envName] = key
}

export class BotRuntime {
  private child: ChildProcess | null = null
  private memory: BotMemoryInfo | null = null
  private lastError = ''
  readonly port = Number(process.env.WHALEGIRL_VOICE_PORT || 59002)

  constructor(private readonly dshHome: string, private readonly resourcesPath = process.resourcesPath) {}

  /**
   * Publish the built-in memory adapter endpoints so the managed profile layer
   * configures the Host Integration for long-term memory.
   * @param memory - loopback URL/token, or null to keep memory off.
   */
  setMemory(memory: BotMemoryInfo | null): void {
    this.memory = memory
  }

  /** Read the persisted Bot settings without creating or defaulting the file. */
  readConfig(): BotRuntimeConfig {
    try {
      const parsed = JSON.parse(readFileSync(join(this.dshHome, 'bot', 'config.json'), 'utf8')) as unknown
      return parsed && typeof parsed === 'object' ? parsed as BotRuntimeConfig : {}
    } catch { return {} }
  }

  /**
   * Install the first-party Host Integration bundle and the managed profile
   * layer into the desktop DSH profile. Idempotent: it regenerates only the
   * marked block and leaves user-authored patch entries untouched.
   * @param config - Bot settings to publish; omitted reads the persisted file.
   */
  prepare(config: BotRuntimeConfig = this.readConfig()): void {
    const profile = join(this.dshHome, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    mkdirSync(modules, { recursive: true })
    const bundle = String(process.env.WHALEGIRL_HOST_INTEGRATION_DIR || '').trim() || join(this.resourcesPath, 'host-integration')
    if (!existsSync(bundle)) { this.lastError = 'host-integration bundle missing'; return }
    const link = join(modules, 'nisse-host-integration')
    try { rmSync(link, { recursive: true, force: true }) } catch {}
    try { symlinkSync(bundle, link, 'dir') } catch (error) { this.lastError = String((error as Error)?.message || error) }
    let manifest: Record<string, unknown> = { name: 'dsh-profile-desktop', private: true, dependencies: {} }
    try { manifest = JSON.parse(readFileSync(join(profile, 'package.json'), 'utf8')) } catch {}
    const dsh = (manifest.dsh && typeof manifest.dsh === 'object' ? manifest.dsh as Record<string, unknown> : {})
    const profileConfig = (dsh.profile && typeof dsh.profile === 'object' ? dsh.profile as Record<string, unknown> : {})
    const bundles = Array.isArray(profileConfig.bundles) ? profileConfig.bundles.map(String) : ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app']
    for (const name of ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', 'nisse-host-integration']) if (!bundles.includes(name)) bundles.push(name)
    profileConfig.bundles = bundles; dsh.profile = profileConfig; manifest.dsh = dsh
    writeFileSync(join(profile, 'package.json'), JSON.stringify(manifest, null, 2) + '\n')
    const packagedLlm = join(this.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
    const fallbackLlm = String(process.env.WHALEGIRL_LLM_ENTRY_PATH || '').trim()
    const llm = existsSync(packagedLlm) ? packagedLlm : (fallbackLlm !== '' ? fallbackLlm : packagedLlm)
    process.env.NISSE_DSH_LLM_ENTRY = llm
    applyLlmEnvironment(config)
    if (String(process.env.WHALEGIRL_VOICE_PERSONA_MODULE || '').trim() === '') {
      const modulePath = join(this.voiceDir, 'server', 'src', 'voice', 'nisse-voice-persona.mjs')
      if (existsSync(modulePath)) process.env.WHALEGIRL_VOICE_PERSONA_MODULE = modulePath
    }
    const patchFile = join(profile, 'cordis.patch.yml')
    let existingPatch = ''
    try { existingPatch = readFileSync(patchFile, 'utf8') } catch {}
    const userPart = existingPatch
      .replace(new RegExp(`${MANAGED_BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${MANAGED_END.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`, 'g'), '')
    const hasUserLlmConfig = /(^|\n)\s*-?\s*id:\s*llm-pi-ai\b/.test(userPart)
    writeFileSync(patchFile, rewriteManagedBlock(existingPatch, managedPatch(config, this.dshHome, llm, hasUserLlmConfig, this.memory)))
  }

  /**
   * Republish a saved Bot settings document: regenerate the managed profile
   * layer now (next DSH host start sees it) and restart the voice gateway.
   * @param config - the freshly saved Bot settings.
   * @returns the new gateway status.
   */
  async applyConfig(config: BotRuntimeConfig): Promise<BotRuntimeStatus> {
    this.prepare(config)
    return this.restart()
  }

  private bridgeFile(): string { return join(this.dshHome, 'bot', 'bridge.json') }
  private descriptorFile(): string { return join(this.dshHome, 'nisse', 'host-integration.json') }

  private get voiceDir(): string {
    return process.env.WHALEGIRL_VOICE_DIR || '/tmp/nisse-m1/w3/qwen-c'
  }

  private get entry(): string {
    return join(this.voiceDir, 'cli/bin/qwenaudio.mjs')
  }

  status(): BotRuntimeStatus {
    return {
      gateway: this.child !== null,
      pid: this.child?.pid ?? null,
      voiceDir: this.voiceDir,
      voiceAvailable: existsSync(this.entry),
      port: this.port,
      error: this.lastError,
    }
  }

  async start(): Promise<BotRuntimeStatus> {
    if (this.child) return this.status()
    if (!existsSync(this.entry)) { this.lastError = 'voice runtime not bundled'; return this.status() }
    const descriptor = await this.waitDescriptor(60000)
    if (!descriptor) { this.lastError = 'DSH Host Integration bridge not ready'; return this.status() }
    const bridge = this.bridgeFile()
    mkdirSync(join(this.dshHome, 'bot'), { recursive: true })
    writeFileSync(bridge, JSON.stringify({ pid: process.pid, port: descriptor.port, token: descriptor.token }, null, 2) + '\n')
    const home = join(this.dshHome, 'bot', 'voice-home')
    const config = this.readConfig()
    const apiKey = String(config.voice?.apiKey || '')
    const node = process.env.WHALEGIRL_NODE || join(this.resourcesPath, 'runtime', 'bin', 'node')
    try {
      this.child = spawn(node, ['cli/bin/qwenaudio.mjs', 'gateway'], {
        cwd: this.voiceDir,
        env: { ...process.env, ...(apiKey ? { DASHSCOPE_API_KEY: apiKey } : {}), NISSE_BOT_PERSONA_JSON: JSON.stringify(config.persona || {}), NISSE_BOT_PROMPT_OVERRIDE: String(config.persona?.promptOverride || ''), DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), PORT: String(this.port), AGENT_PROTOCOL: 'none', NISSE_ROUTE_C: '1', NISSE_BRIDGE_ONLY: '1', NISSE_BRIDGE_FILE: bridge },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child.once('exit', (code) => { this.lastError = 'gateway exited ' + String(code ?? ''); this.child = null })
      this.child.stderr?.on('data', (chunk) => { this.lastError = String(chunk).trim().slice(-500) })
      this.child.on('error', (error) => { this.lastError = String(error?.message || error) })
    } catch (error) { this.lastError = String((error as Error)?.message || error) }
    return this.status()
  }

  private async waitDescriptor(timeoutMs: number): Promise<{ port: number; token: string } | null> {
    const start = Date.now()
    while (Date.now() - start < timeoutMs) {
      try {
        const parsed = JSON.parse(readFileSync(this.descriptorFile(), 'utf8')) as { port?: number; token?: string }
        if (typeof parsed.port === 'number' && typeof parsed.token === 'string') return { port: parsed.port, token: parsed.token }
      } catch {}
      await new Promise(resolve => setTimeout(resolve, 500))
    }
    return null
  }

  async stop(): Promise<BotRuntimeStatus> {
    if (this.child) {
      try { this.child.kill('SIGTERM') } catch {}
      this.child = null
    }
    return this.status()
  }

  async restart(): Promise<BotRuntimeStatus> {
    await this.stop()
    return this.start()
  }
}
