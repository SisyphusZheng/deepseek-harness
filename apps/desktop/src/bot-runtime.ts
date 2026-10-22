/** Supervises the optional voice gateway child owned by the WhaleGirl Bot desktop shell. */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
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

  constructor(private readonly dshHome: string) {}

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
    const home = join(this.dshHome, 'bot', 'voice-home')
    const node = process.env.WHALEGIRL_NODE || 'node'
    try {
      this.child = spawn(node, ['cli/bin/qwenaudio.mjs', 'gateway'], {
        cwd: this.voiceDir,
        env: { ...process.env, HOME: home, XDG_CONFIG_HOME: join(home, '.config'), XDG_DATA_HOME: join(home, '.local/share'), XDG_STATE_HOME: join(home, '.local/state'), PORT: String(this.port), AGENT_PROTOCOL: 'none', NISSE_ROUTE_C: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      this.child.once('exit', () => { this.child = null })
      this.child.on('error', (error) => { this.lastError = String(error?.message || error) })
    } catch (error) { this.lastError = String((error as Error)?.message || error) }
    return this.status()
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
