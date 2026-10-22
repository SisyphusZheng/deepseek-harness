/** Supervises the optional voice gateway child owned by the WhaleGirl Bot desktop shell. */
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

export class BotRuntime {
  private child: ChildProcess | null = null
  private lastError = ''
  readonly port = Number(process.env.WHALEGIRL_VOICE_PORT || 59002)

  constructor(private readonly dshHome: string, private readonly resourcesPath = process.resourcesPath) {}

  /** Install the first-party Host Integration bundle into the desktop DSH profile. */
  prepare(): void {
    const profile = join(this.dshHome, 'profiles', 'desktop')
    const modules = join(profile, 'node_modules')
    mkdirSync(modules, { recursive: true })
    const bundle = join(this.resourcesPath, 'host-integration')
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
    const llm = join(this.resourcesPath, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-llm', 'lib', 'index.js')
    process.env.NISSE_DSH_LLM_ENTRY = llm
    const patch = `- id: nisse-host-integration\n  name: 'nisse-host-integration'\n  config:\n    provider: opencode-go\n    model: deepseek-v4.1-flash\n    reasoningEffort: low\n    ipcDir: ${join(this.dshHome, 'nisse')}\n    workspaceDir: ${join(this.dshHome, 'workspace')}\n    dshLlmEntry: ${llm}\n`
    writeFileSync(join(profile, 'cordis.patch.yml'), patch)
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
    let apiKey = ''
    try { const cfg = JSON.parse(readFileSync(join(this.dshHome, 'bot', 'config.json'), 'utf8')) as { voice?: { apiKey?: string } }; apiKey = String(cfg.voice?.apiKey || '') } catch {}
    const node = process.env.WHALEGIRL_NODE || join(this.resourcesPath, 'runtime', 'bin', 'node')
    try {
      this.child = spawn(node, ['cli/bin/qwenaudio.mjs', 'gateway'], {
        cwd: this.voiceDir,
        env: { ...process.env, ...(apiKey ? { DASHSCOPE_API_KEY: apiKey } : {}), DSH_DESKTOP_NODE_EXECUTABLE: process.execPath, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), PORT: String(this.port), AGENT_PROTOCOL: 'none', NISSE_ROUTE_C: '1', NISSE_BRIDGE_ONLY: '1', NISSE_BRIDGE_FILE: bridge },
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
