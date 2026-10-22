/**
 * Bot settings provider catalog and connection probes.
 *
 * The settings page offers a fixed, curated catalog (cloud voice providers and
 * the LLM routes this build can verify) instead of free-form guessing. Every
 * probe is a pure function over injected `fetch`, returns a closed result shape
 * and NEVER echoes a secret: only the normalized origin and the provider's own
 * error text travel back to the settings page.
 */

/** One LLM route the Bot session can be pointed at. */
export interface LlmProviderOption {
  readonly id: string
  readonly label: string
  /** Environment variable the desktop shell publishes the key under before starting the DSH host. */
  readonly apiKeyEnv: string
  /** Probe base URL; an empty value means the user must supply one. */
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly requiresBaseUrl?: boolean
}

/** One voice front-end provider. */
export interface VoiceProviderOption {
  readonly id: string
  readonly label: string
  /** Realtime endpoint scheme; `local` providers do not talk to the network. */
  readonly baseUrl: string
  readonly models: readonly string[]
  readonly voices: readonly string[]
  readonly kind: 'cloud' | 'local'
}

/** LLM routes offered by Bot settings; the first entry is the shipped default. */
export const LLM_PROVIDERS: readonly LlmProviderOption[] = [
  { id: 'opencode-go', label: 'OpenCode Go', apiKeyEnv: 'OPENCODE_GO_API_KEY', baseUrl: 'https://opencode.ai/zen/go/v1', models: ['deepseek-v4.1-flash', 'deepseek-v4.1'] },
  { id: 'deepseek', label: 'DeepSeek', apiKeyEnv: 'DEEPSEEK_API_KEY', baseUrl: 'https://api.deepseek.com/v1', models: ['deepseek-chat', 'deepseek-reasoner'] },
  { id: 'dashscope', label: 'DashScope（通义千问）', apiKeyEnv: 'DASHSCOPE_API_KEY', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', models: ['qwen3-max', 'qwen-plus'] },
  { id: 'openai', label: 'OpenAI', apiKeyEnv: 'OPENAI_API_KEY', baseUrl: 'https://api.openai.com/v1', models: ['gpt-5.1', 'gpt-5.1-mini'] },
  { id: 'custom', label: '自定义 OpenAI 兼容', apiKeyEnv: 'WHALEGIRL_LLM_API_KEY', baseUrl: '', models: [], requiresBaseUrl: true },
]

/** Voice providers offered by Bot settings; the first entry is the natural-sounding default. */
export const VOICE_PROVIDERS: readonly VoiceProviderOption[] = [
  { id: 'dashscope', label: 'DashScope Qwen Realtime（默认）', baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', models: ['qwen-audio-3.0-realtime-plus'], voices: ['longanxiaoxin', 'longan'], kind: 'cloud' },
  { id: 'stepfun', label: 'StepFun Realtime', baseUrl: 'wss://api.stepfun.com/v1/realtime', models: ['stepaudio-3-realtime-preview'], voices: [''], kind: 'cloud' },
  { id: 'doubao-seeduplex', label: '豆包 Seeduplex', baseUrl: 'wss://openspeech.bytedance.com/api/v3/duplex/realtime/dialogue', models: ['1.2.6.1'], voices: ['zh_female_vv_jupiter_bigtts'], kind: 'cloud' },
  { id: 'local', label: '本地 ASR（设备内识别）', baseUrl: '', models: ['SenseVoiceSmall', 'Whisper small'], voices: [''], kind: 'local' },
]

/** One connection probe's closed result. Secrets never appear in it. */
export interface ProviderTestResult {
  readonly ok: boolean
  readonly kind: 'llm' | 'voice'
  readonly provider: string
  readonly origin: string
  readonly latencyMs: number
  readonly detail: string
  readonly error?: string
  readonly hint?: string
}

/** Injected dependencies for a probe (real `fetch` in production, a mock in tests). */
export interface ProviderTestDeps {
  readonly fetch?: typeof fetch
  readonly timeoutMs?: number
  readonly now?: () => number
}

const DEFAULT_TIMEOUT_MS = 8_000

/** Look one LLM route up by id; unknown ids are reported instead of guessed. */
export function llmProviderOf(id: string): LlmProviderOption | undefined {
  return LLM_PROVIDERS.find(provider => provider.id === id)
}

const VOICE_PROVIDER_ALIASES: Readonly<Record<string, string>> = {
  DashScope: 'dashscope', dashscope: 'dashscope', qwen: 'dashscope',
  stepfun: 'stepfun', 'doubao-seeduplex': 'doubao-seeduplex', doubao: 'doubao-seeduplex',
  seeduplex: 'doubao-seeduplex', volcengine: 'doubao-seeduplex',
  local: 'local', 'local-asr': 'local',
}

/** Normalize a stored/legacy voice provider spelling to its catalog id. */
export function normalizeVoiceProviderId(raw: string): string {
  const value = String(raw || '').trim()
  return VOICE_PROVIDER_ALIASES[value] ?? value
}

/** Look one voice provider up by id; unknown ids are reported instead of guessed. */
export function voiceProviderOf(id: string): VoiceProviderOption | undefined {
  const normalized = normalizeVoiceProviderId(id)
  return VOICE_PROVIDERS.find(provider => provider.id === normalized)
}

/** Normalize a base URL for probing: trim, require an http(s)/ws(s) absolute URL, drop a trailing slash. */
export function probeBaseUrl(raw: string, fallback: string): string {
  const candidate = String(raw || '').trim() || String(fallback || '').trim()
  if (candidate === '') throw new Error('baseUrl is required')
  const url = new URL(candidate)
  if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) throw new Error('baseUrl must be a network URL')
  url.protocol = url.protocol === 'wss:' ? 'https:' : url.protocol === 'ws:' ? 'http:' : url.protocol
  const path = url.pathname.replace(/\/+$/, '')
  return `${url.origin}${path}`
}

/** Render one origin for the response; never includes credentials or query strings. */
function originOf(base: string): string {
  try {
    const url = new URL(base)
    return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, '')}`
  } catch { return '<invalid>' }
}

/** Map a transport-level throw to a human-readable Chinese hint. */
function networkHint(error: unknown): string {
  const message = String((error as Error)?.message || error)
  if (/abort|timeout/i.test(message)) return '连接超时（8 秒）：请检查服务地址、网络或代理设置。'
  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message)) return '域名解析失败：请检查服务地址是否写对、网络是否可用。'
  if (/ECONNREFUSED/i.test(message)) return '连接被拒绝：服务地址或端口不可达。'
  if (/ECONNRESET|socket hang up/i.test(message)) return '连接被重置：可能是代理或 TLS 拦截导致。'
  if (/certificate|self.signed/i.test(message)) return 'TLS 证书校验失败：请确认服务地址可靠。'
  return '网络请求失败：请检查服务地址与网络连接。'
}

/** Map an HTTP status to a human-readable Chinese hint. */
function statusHint(status: number): string {
  if (status === 401) return '鉴权失败（401）：API Key 无效、过期或与所选 provider 不匹配。'
  if (status === 403) return '无权限（403）：Key 没有该模型的访问权限，或账户被限制。'
  if (status === 404) return '接口不存在（404）：请检查服务地址（baseUrl）或模型名。'
  if (status === 429) return '请求过多（429）：额度用尽或触发限流，请稍后再试。'
  if (status >= 500) return `服务端错误（${status}）：provider 暂时不可用，请稍后再试。`
  return `请求被拒绝（HTTP ${status}）。`
}

/** Read a bounded provider error body without failing the probe. */
async function snippet(response: Response): Promise<string> {
  try {
    const text = (await response.text()).slice(0, 300)
    return text.replace(/\s+/g, ' ').trim()
  } catch { return '' }
}

/**
 * Probe one LLM route by listing its models.
 * @param input - the settings values to probe (key may be empty → distinct hint).
 * @param deps - injectable fetch/clock/timeout for tests.
 * @returns a closed result whose `detail`/`hint` are safe to show.
 */
export async function testLlmProvider(
  input: { provider: string; model: string; baseUrl: string; apiKey: string },
  deps: ProviderTestDeps = {},
): Promise<ProviderTestResult> {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = now()
  const base = String(input.baseUrl || '').trim()
  let origin = '<invalid>'
  const result = (fields: Omit<ProviderTestResult, 'kind' | 'provider' | 'latencyMs' | 'origin'>): ProviderTestResult => ({
    kind: 'llm', provider: String(input.provider || ''), origin, latencyMs: Math.max(0, now() - startedAt), ...fields,
  })
  const catalog = llmProviderOf(String(input.provider || ''))
  if (catalog === undefined) return result({ ok: false, detail: '未知的 LLM provider', error: 'UNKNOWN_PROVIDER', hint: '请在 LLM 供应商下拉框里选择一个受支持的 provider。' })
  if (catalog.requiresBaseUrl && base === '') return result({ ok: false, detail: '缺少服务地址', error: 'MISSING_BASE_URL', hint: '自定义 OpenAI 兼容 provider 必须填写 baseUrl。' })
  const keyEnv = catalog.apiKeyEnv
  const key = String(input.apiKey || '').trim()
  if (key === '') return result({ ok: false, detail: '缺少 API Key', error: 'MISSING_API_KEY', hint: `请在 Bot 设置填入 API Key（将继承为 ${keyEnv} 传给 DSH）。` })
  let url: string
  try {
    url = probeBaseUrl(base, catalog.baseUrl)
    origin = originOf(url)
  } catch (error) {
    return result({ ok: false, detail: '服务地址无效', error: 'INVALID_BASE_URL', hint: networkHint(error) })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetchImpl(`${url}/models`, {
      method: 'GET',
      headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await snippet(response)
    if (!response.ok) {
      return result({ ok: false, detail: `HTTP ${response.status}${body === '' ? '' : `：${body}`}`, error: 'HTTP_ERROR', hint: statusHint(response.status) })
    }
    let count = 0
    try {
      const parsed = JSON.parse(body) as { data?: unknown; models?: unknown }
      if (Array.isArray(parsed.data)) count = parsed.data.length
      else if (Array.isArray(parsed.models)) count = parsed.models.length
    } catch { /* a non-JSON 200 still proves the endpoint answers */ }
    return result({ ok: true, detail: `连接成功，模型名 ${String(input.model || catalog.models[0] || '')}${count > 0 ? `，服务端列出 ${String(count)} 个模型` : ''}` })
  } catch (error) {
    return result({ ok: false, detail: String((error as Error)?.message || error), error: 'NETWORK_ERROR', hint: networkHint(error) })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Probe one voice provider. A cloud realtime endpoint is verified for
 * reachability and key transport, not for a full audio handshake (the gateway
 * performs that on start and reports its own error); local providers are
 * configuration-only.
 * @param input - the settings values to probe.
 * @param deps - injectable fetch/clock/timeout for tests.
 * @returns a closed result whose `detail`/`hint` are safe to show.
 */
export async function testVoiceProvider(
  input: { provider: string; baseUrl: string; model: string; apiKey: string },
  deps: ProviderTestDeps = {},
): Promise<ProviderTestResult> {
  const now = deps.now ?? Date.now
  const fetchImpl = deps.fetch ?? fetch
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const startedAt = now()
  const providerId = String(input.provider || '')
  let origin = '<invalid>'
  const result = (fields: Omit<ProviderTestResult, 'kind' | 'provider' | 'latencyMs' | 'origin'>): ProviderTestResult => ({
    kind: 'voice', provider: providerId, origin, latencyMs: Math.max(0, now() - startedAt), ...fields,
  })
  const catalog = voiceProviderOf(providerId)
  if (catalog === undefined) return result({ ok: false, detail: '未知的语音 provider', error: 'UNKNOWN_PROVIDER', hint: '请在语音供应商下拉框里选择一个受支持的 provider。' })
  if (catalog.kind === 'local') return result({ ok: false, detail: '本地 ASR 不连接云端', error: 'LOCAL_PROVIDER', hint: '本地 ASR 在设备内识别，无需连接测试；首次使用会自动下载模型。' })
  if (String(input.apiKey || '').trim() === '') return result({ ok: false, detail: '缺少 API Key', error: 'MISSING_API_KEY', hint: '请填入语音服务的 API Key（DashScope 等云服务需要）。' })
  let url: string
  try {
    url = probeBaseUrl(input.baseUrl, catalog.baseUrl)
    origin = originOf(url)
  } catch (error) {
    return result({ ok: false, detail: '服务地址无效', error: 'INVALID_BASE_URL', hint: networkHint(error) })
  }
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('timeout')), timeoutMs)
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { authorization: `Bearer ${String(input.apiKey || '').trim()}`, accept: 'application/json' },
      signal: controller.signal,
    })
    const body = await snippet(response)
    if (response.status === 401 || response.status === 403) {
      return result({ ok: false, detail: `HTTP ${response.status}${body === '' ? '' : `：${body}`}`, error: 'HTTP_ERROR', hint: statusHint(response.status) })
    }
    if (response.status >= 500) {
      return result({ ok: false, detail: `HTTP ${response.status}`, error: 'HTTP_ERROR', hint: statusHint(response.status) })
    }
    return result({ ok: true, detail: `实时语音端点可达（HTTP ${response.status}），实际语音连接会在启动语音网关时建立` })
  } catch (error) {
    return result({ ok: false, detail: String((error as Error)?.message || error), error: 'NETWORK_ERROR', hint: networkHint(error) })
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Resolve a provider's wire defaults from the catalog; used when saving so a
 * route always persists a concrete base URL/model.
 * @param provider - LLM route id.
 * @param current - the user's current values (kept when non-empty).
 * @returns normalized baseUrl/model/apiKeyEnv.
 */
export function resolveLlmDefaults(
  provider: string,
  current: { baseUrl?: string; model?: string } = {},
): { baseUrl: string; model: string; apiKeyEnv: string } {
  const catalog = llmProviderOf(provider)
  return {
    baseUrl: String(current.baseUrl || '').trim() || catalog?.baseUrl || '',
    model: String(current.model || '').trim() || catalog?.models[0] || '',
    apiKeyEnv: catalog?.apiKeyEnv || 'WHALEGIRL_LLM_API_KEY',
  }
}

/** Resolve a voice provider's wire defaults; key/model/voice stay user-editable. */
export function resolveVoiceDefaults(
  provider: string,
  current: { baseUrl?: string; model?: string; voice?: string } = {},
): { baseUrl: string; model: string; voice: string } {
  const catalog = voiceProviderOf(provider)
  return {
    baseUrl: String(current.baseUrl || '').trim() || catalog?.baseUrl || '',
    model: String(current.model || '').trim() || catalog?.models[0] || '',
    voice: String(current.voice || '').trim() || catalog?.voices[0] || '',
  }
}
