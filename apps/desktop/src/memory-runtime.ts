/**
 * Built-in long-term memory runtime for the WhaleGirl Bot shell.
 *
 * Owns the two processes behind Hindsight memory:
 *  - the local Hindsight API server (embedded pg0 + local embeddings, loopback only),
 *  - the thin product MemoryAdapter sidecar (loopback HTTP, bearer token) that
 *    exposes digest/write/search/forget/export for the first-party Host Integration.
 *
 * The runtime is optional and fail-soft: when the server or sidecar cannot start,
 * the Bot keeps working without long-term memory and the settings page shows why.
 * Nothing here leaves the machine except the model service the user already chose.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { join } from 'node:path'

/** What the shell publishes to the Host Integration profile layer and the Bot settings page. */
export interface MemoryRuntimeStatus {
  enabled: boolean
  server: string | null
  sidecar: string | null
  bank: string | null
  dataRoot: string
  error: string
}

/** One JSON answer from the MemoryAdapter sidecar. */
export interface MemorySidecarResult {
  ok?: boolean
  error?: { code?: string; message?: string } | string
  [key: string]: unknown
}

/** Shape returned by `MemoryRuntime.request`. */
export interface MemoryRuntimeResponse {
  status: number
  json: MemorySidecarResult | null
}

const DEFAULT_HINDSIGHT_URL = 'http://127.0.0.1:18888'
const SIDECAR_TIMEOUT_MS = 20_000
const SERVER_TIMEOUT_MS = 180_000

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

export class MemoryRuntime {
  private sidecar: ChildProcess | null = null
  private descriptor: { port: number; token: string; bank: string } | null = null
  private lastError = ''
  private startedServer = false
  private serverUrl = DEFAULT_HINDSIGHT_URL
  private enabled = false

  /**
   * @param dshHome - shared DSH home; memory data lives under `<dshHome>/memory`.
   * @param resourcesPath - packaged resources root.
   * @param appPath - application root (`apps/desktop` in development).
   * @param development - whether the shell runs unpackaged.
   */
  constructor(
    private readonly dshHome: string,
    private readonly resourcesPath: string,
    private readonly appPath: string,
    private readonly development: boolean,
  ) {}

  private get repositoryRoot(): string {
    return String(process.env.WHALEGIRL_PROJECT_ROOT || '').trim() || join(this.appPath, '..', '..')
  }

  private get hindsightDir(): string {
    return String(process.env.WHALEGIRL_HINDSIGHT_DIR || '').trim()
      || (this.development
        ? join(this.repositoryRoot, 'spike', 'm1-c-hindsight')
        : join(this.resourcesPath, 'memory', 'hindsight'))
  }

  private get sidecarPath(): string {
    return String(process.env.WHALEGIRL_MEMORY_SIDECAR || '').trim()
      || (this.development
        ? join(this.repositoryRoot, 'm4', 'memory', 'sidecar.mjs')
        : join(this.resourcesPath, 'memory', 'sidecar.mjs'))
  }

  /** Data root shared by the Hindsight server home and the adapter runtime files. */
  get dataRoot(): string {
    return join(this.dshHome, 'memory')
  }

  /** Loopback URL the Host Integration uses for digest/write/search/forget/export. */
  get url(): string | null {
    return this.descriptor === null ? null : `http://127.0.0.1:${String(this.descriptor.port)}`
  }

  /** Bearer token the Host Integration must present. */
  get token(): string | null {
    return this.descriptor === null ? null : this.descriptor.token
  }

  status(): MemoryRuntimeStatus {
    return {
      enabled: this.enabled,
      server: this.serverUrl,
      sidecar: this.url,
      bank: this.descriptor?.bank ?? null,
      dataRoot: this.dataRoot,
      error: this.lastError,
    }
  }

  private async healthyServer(): Promise<boolean> {
    try {
      const response = await fetch(`${this.serverUrl}/health`, { signal: AbortSignal.timeout(2500) })
      return response.ok
    } catch { return false }
  }

  /** Start the embedded Hindsight server when it is not already listening. */
  private async ensureServer(): Promise<void> {
    if (await this.healthyServer()) return
    const script = join(this.hindsightDir, 'scripts', 'run-server.sh')
    if (!existsSync(script)) throw new Error(`Hindsight runtime missing: ${script}`)
    mkdirSync(join(this.dataRoot, 'logs'), { recursive: true })
    const child = spawn('/bin/bash', [script], {
      cwd: this.hindsightDir,
      env: {
        ...process.env,
        NISSE_M1C_ROOT: String(process.env.WHALEGIRL_HINDSIGHT_ROOT || '/tmp/nisse-m1-hindsight'),
        NISSE_M1C_PORT: String(new URL(this.serverUrl).port || '18888'),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('exit', (code) => {
      if (code !== 0 && !this.lastError) this.lastError = `hindsight server exited ${String(code)}: ${output.slice(-400)}`
    })
    this.startedServer = true
    const started = Date.now()
    while (Date.now() - started < SERVER_TIMEOUT_MS) {
      if (await this.healthyServer()) return
      await sleep(500)
    }
    throw new Error(`Hindsight server did not become healthy: ${output.slice(-400)}`)
  }

  /** Start the MemoryAdapter sidecar and wait for its descriptor file. */
  private async ensureSidecar(): Promise<void> {
    if (this.descriptor !== null) return
    if (!existsSync(this.sidecarPath)) throw new Error(`memory sidecar missing: ${this.sidecarPath}`)
    mkdirSync(this.dataRoot, { recursive: true })
    const descriptorFile = join(this.dataRoot, 'sidecar.json')
    try { rmSync(descriptorFile, { force: true }) } catch { /* ignore */ }
    const token = randomUUID()
    const bank = String(process.env.WHALEGIRL_MEMORY_BANK || 'whalegirl:bot')
    const child = spawn(process.execPath, [this.sidecarPath], {
      cwd: this.dataRoot,
      env: {
        ...process.env,
        NISSE_M4_MEMORY_ROOT: this.dataRoot,
        NISSE_M4_MEMORY_TOKEN: token,
        NISSE_M4_BANK: bank,
        HINDSIGHT_URL: this.serverUrl,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    this.sidecar = child
    let output = ''
    child.stdout?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.stderr?.on('data', (chunk: Buffer) => { output += chunk.toString() })
    child.once('exit', (code) => {
      this.sidecar = null
      if (code !== 0 && !this.lastError) this.lastError = `memory sidecar exited ${String(code)}: ${output.slice(-400)}`
    })
    const started = Date.now()
    while (Date.now() - started < SIDECAR_TIMEOUT_MS) {
      if (existsSync(descriptorFile)) {
        try {
          const parsed = JSON.parse(readFileSync(descriptorFile, 'utf8')) as { port?: number; token?: string; bank?: string }
          if (typeof parsed.port === 'number' && typeof parsed.token === 'string') {
            this.descriptor = { port: parsed.port, token: parsed.token, bank: parsed.bank ?? bank }
            return
          }
        } catch { /* descriptor is being written */ }
      }
      await sleep(150)
    }
    throw new Error(`memory sidecar did not publish its descriptor: ${output.slice(-400)}`)
  }

  /**
   * Start the built-in memory stack. Fail-soft: a failure is reported through
   * {@link status} and the Bot continues without long-term memory.
   * @param config - Bot settings (memory.enabled gates the whole stack).
   * @returns the runtime status after the attempt.
   */
  async start(config: { memory?: { enabled?: boolean } } = {}): Promise<MemoryRuntimeStatus> {
    this.enabled = config.memory?.enabled !== false
    this.lastError = ''
    if (!this.enabled) {
      await this.stop()
      return this.status()
    }
    try {
      this.serverUrl = String(process.env.NISSE_HINDSIGHT_URL || '').trim() || DEFAULT_HINDSIGHT_URL
      await this.ensureServer()
      await this.ensureSidecar()
    } catch (error) {
      this.lastError = String((error as Error)?.message || error)
    }
    return this.status()
  }

  /** Stop the sidecar (and the server when this shell started it). */
  async stop(): Promise<void> {
    if (this.sidecar !== null) {
      try { this.sidecar.kill('SIGTERM') } catch { /* ignore */ }
      this.sidecar = null
    }
    this.descriptor = null
    if (this.startedServer) {
      try {
        const pidFile = join(String(process.env.WHALEGIRL_HINDSIGHT_ROOT || '/tmp/nisse-m1-hindsight'), 'run', 'server.pid')
        if (existsSync(pidFile)) process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 'SIGTERM')
      } catch { /* ignore */ }
      this.startedServer = false
    }
  }

  /** Restart the memory stack after a settings change. */
  async restart(config: { memory?: { enabled?: boolean } } = {}): Promise<MemoryRuntimeStatus> {
    await this.stop()
    return this.start(config)
  }

  /**
   * Call one MemoryAdapter sidecar endpoint with the runtime token.
   * @param path - sidecar path such as `/search`.
   * @param body - JSON body (POST).
   * @returns status plus parsed JSON; `{status: 0}` when the sidecar is unavailable.
   */
  async request(path: string, body: unknown = {}): Promise<MemoryRuntimeResponse> {
    if (this.descriptor === null) return { status: 0, json: { ok: false, error: 'memory runtime unavailable' } }
    try {
      const response = await fetch(`http://127.0.0.1:${String(this.descriptor.port)}${path}`, {
        method: 'POST',
        headers: { authorization: `Bearer ${this.descriptor.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      })
      const json = await response.json().catch(() => null) as MemorySidecarResult | null
      return { status: response.status, json }
    } catch (error) {
      return { status: 0, json: { ok: false, error: String((error as Error)?.message || error) } }
    }
  }

  /** Write a marker file so external tooling can find the runtime descriptor. */
  publishDescriptor(): void {
    if (this.descriptor === null) return
    try {
      mkdirSync(this.dataRoot, { recursive: true })
      const file = join(this.dataRoot, 'runtime.json')
      writeFileSync(file, JSON.stringify({ ...this.descriptor, url: this.url, dataRoot: this.dataRoot }, null, 2) + '\n', { mode: 0o600 })
    } catch { /* ignore */ }
  }
}
