/** Local Bot settings/config service for the WhaleGirlBot desktop shell. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { join } from 'node:path'
import {
  LLM_PROVIDERS,
  VOICE_PROVIDERS,
  testLlmProvider,
  testVoiceProvider,
  type ProviderTestDeps,
  type ProviderTestResult,
} from './bot-providers.ts'
import {
  appendMemoryHistory,
  mergeBotConfigEdit,
  normalizeMemoryAdminList,
  normalizeMemoryAdminMutation,
  normalizePromptPreview,
  normalizeRemoteMemoryHistory,
  readBotConfigFile,
  readMemoryHistory,
  toBotConfigView,
  writeBotConfigFile,
  type BotConfig,
  type BotConfigView,
  type BotMemoryCorrectInput,
  type BotMemoryDeleteInput,
  type BotMemoryHistoryQuery,
  type BotMemoryListQuery,
  type MemoryHistoryEntry,
} from './bot-settings-model.ts'
import { buildBotSettingsPage } from './bot-settings-page.ts'

export { DEFAULT_BOT_CONFIG } from './bot-settings-model.ts'
export type { BotConfig, BotConfigView } from './bot-settings-model.ts'

export const BOT_CONFIG_PORT = 59100

/** The settings page and the config service share one loopback origin; this path serves the embedded page. */
const SETTINGS_PATH = '/bot/settings'

/** Inline provider catalog for the page's select options (never carries secrets). */
function providerCatalogJson(): string {
  return JSON.stringify({
    voice: VOICE_PROVIDERS.map(provider => ({
      id: provider.id, label: provider.label, baseUrl: provider.baseUrl,
      models: [...provider.models], voices: [...provider.voices], kind: provider.kind,
    })),
    llm: LLM_PROVIDERS.map(provider => ({
      id: provider.id, label: provider.label, baseUrl: provider.baseUrl,
      models: [...provider.models], requiresBaseUrl: provider.requiresBaseUrl === true,
    })),
  }).replaceAll('<', '\\u003c')
}

function page(): string {
  return buildBotSettingsPage(providerCatalogJson())
}

export interface BotConfigHooks {
  status?: () => unknown
  onConfigSaved?: (config: BotConfig) => void | Promise<void>
  onRestart?: () => unknown | Promise<unknown>
  onToggleMain?: () => unknown | Promise<unknown>
  onOpenSettings?: () => unknown | Promise<unknown>
  onApproval?: (id: string, decision: string) => unknown | Promise<unknown>
  /** Native directory picker; returns the chosen absolute path or null when cancelled. */
  onPickDirectory?: () => string | null | Promise<string | null>
  /** Built-in long-term memory runtime status. */
  onMemoryStatus?: () => unknown
  /** Recall from long-term memory. */
  onMemorySearch?: (query: string) => unknown | Promise<unknown>
  /** Export all long-term memory. */
  onMemoryExport?: () => unknown | Promise<unknown>
  /** Forget all long-term memory. */
  onMemoryForget?: () => unknown | Promise<unknown>
  /** List memories for the settings-page administration view (paged). */
  onMemoryList?: (query: BotMemoryListQuery) => unknown | Promise<unknown>
  /** Correct one memory: write the new text, then delete the old memory (rollback on failure). */
  onMemoryCorrect?: (input: BotMemoryCorrectInput) => unknown | Promise<unknown>
  /** Delete one memory by id. */
  onMemoryDelete?: (input: BotMemoryDeleteInput) => unknown | Promise<unknown>
  /** Optional remote/native edit history for one memory (local page history works without it). */
  onMemoryHistory?: (query: BotMemoryHistoryQuery) => unknown | Promise<unknown>
  /** Read-only preview of the assembled DSH persona prompt plus the voice-mode prefix. */
  onPromptPreview?: (config: BotConfigView) => unknown | Promise<unknown>
}

/** Optional injectable seams (tests supply a mock fetch; production uses the real one). */
export interface BotConfigServerOptions {
  readonly fetchImpl?: typeof fetch
  readonly testTimeoutMs?: number
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
  const text = Buffer.concat(chunks).toString('utf8')
  if (text.trim() === '') return {}
  return JSON.parse(text)
}

async function readBodyObject(req: IncomingMessage): Promise<Record<string, unknown>> {
  const parsed = await readBody(req).catch(() => ({}))
  return parsed !== null && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
}

function stringOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function clampInteger(value: unknown, fallback: number, min: number, max: number): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return fallback
  return Math.min(max, Math.max(min, Math.floor(numeric)))
}

function errorMessage(error: unknown): string {
  return String((error as Error)?.message || error)
}

function errorPayload(code: string, message: string): { ok: false; error: { code: string; message: string } } {
  return { ok: false, error: { code, message } }
}

export async function startBotConfigServer(
  dshHome: string,
  port = BOT_CONFIG_PORT,
  hooks: BotConfigHooks = {},
  options: BotConfigServerOptions = {},
): Promise<{ close: () => Promise<void>; port: number }> {
  const configDir = join(dshHome, 'bot')
  const readConfig = (): Promise<BotConfig> => readBotConfigFile(configDir)
  const writeConfig = (value: unknown): Promise<BotConfig> => writeBotConfigFile(configDir, value)
  /** Best-effort local edit log (a failed history write must never fail a memory operation). */
  const recordHistory = async (entry: MemoryHistoryEntry): Promise<void> => {
    try { await appendMemoryHistory(dshHome, entry) } catch { /* history is best-effort */ }
  }
  const testDeps: ProviderTestDeps = {
    ...(options.fetchImpl === undefined ? {} : { fetch: options.fetchImpl }),
    ...(options.testTimeoutMs === undefined ? {} : { timeoutMs: options.testTimeoutMs }),
  }
  const server: Server = createServer(async (req, res) => {
    const reply = (statusCode: number, payload: unknown): void => {
      const body = JSON.stringify(payload)
      res.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) })
      res.end(body)
    }
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === SETTINGS_PATH) {
        const html = page()
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
        res.end(html)
        return
      }
      if (url.pathname === '/bot/status' && req.method === 'GET') { reply(200, { ok: true, status: hooks.status?.() ?? null }); return }
      if (url.pathname === '/bot/restart' && req.method === 'POST') { reply(200, { ok: true, status: await hooks.onRestart?.() ?? null }); return }
      if (url.pathname === '/bot/open-settings' && req.method === 'POST') { reply(200, { ok: true, result: await hooks.onOpenSettings?.() ?? null }); return }
      if (url.pathname === '/bot/approval' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({})) as { id?: string; decision?: string }
        const result = await hooks.onApproval?.(String(body.id || ''), String(body.decision || '')) ?? null
        reply(200, { ok: true, result })
        return
      }
      if (url.pathname === '/bot/toggle-main' && req.method === 'POST') { reply(200, { ok: true, result: await hooks.onToggleMain?.() ?? null }); return }
      if (url.pathname === '/bot/workspace/pick' && req.method === 'POST') {
        try {
          const picked = await hooks.onPickDirectory?.() ?? null
          if (picked === null || picked === '') { reply(200, { ok: false, error: '未选择目录' }); return }
          reply(200, { ok: true, path: picked })
        } catch (error) {
          reply(200, { ok: false, error: errorMessage(error) })
        }
        return
      }
      if (url.pathname === '/bot/memory/status' && req.method === 'GET') { reply(200, { ok: true, status: hooks.onMemoryStatus?.() ?? null }); return }
      if (url.pathname === '/bot/memory/search' && req.method === 'POST') {
        const body = await readBody(req).catch(() => ({})) as { query?: string }
        const result = await hooks.onMemorySearch?.(String(body.query || '')) ?? null
        reply(200, { ok: true, result })
        return
      }
      if (url.pathname === '/bot/memory/export' && req.method === 'POST') { reply(200, { ok: true, result: await hooks.onMemoryExport?.() ?? null }); return }
      if (url.pathname === '/bot/memory/forget' && req.method === 'POST') { reply(200, { ok: true, result: await hooks.onMemoryForget?.() ?? null }); return }
      if (url.pathname === '/bot/memory/list' && req.method === 'POST') {
        const body = await readBodyObject(req)
        const query: BotMemoryListQuery = {
          limit: clampInteger(body.limit, 50, 1, 100),
          offset: clampInteger(body.offset, 0, 0, 1_000_000),
        }
        const search = stringOf(body.query)
        const kind = stringOf(body.kind)
        const namespace = stringOf(body.namespace)
        if (search !== '') query.query = search
        if (kind !== '') query.kind = kind
        if (namespace !== '') query.namespace = namespace
        if (hooks.onMemoryList === undefined) {
          reply(200, { ok: true, result: { available: false, items: [], hasMore: false, note: '记忆管理未接线：main.ts 未提供 onMemoryList hook（可接到 memory-runtime 的 /list）。' } })
          return
        }
        try {
          const result = normalizeMemoryAdminList(await hooks.onMemoryList(query), query.limit ?? 50)
          reply(200, { ok: true, result })
        } catch (error) {
          reply(200, errorPayload('MEMORY_LIST_FAILED', errorMessage(error)))
        }
        return
      }
      if (url.pathname === '/bot/memory/correct' && req.method === 'POST') {
        const body = await readBodyObject(req)
        const id = stringOf(body.id)
        const text = stringOf(body.text).slice(0, 4000)
        const kind = stringOf(body.kind) || 'fact'
        const namespace = stringOf(body.namespace) || 'global'
        const previousText = stringOf(body.previousText).slice(0, 8000)
        if (id === '' || text === '') { reply(200, errorPayload('INVALID_REQUEST', '需要记忆 id 与新内容（text 不能为空）')); return }
        if (hooks.onMemoryCorrect === undefined) {
          reply(200, { ok: true, result: { ok: false, available: false, id, note: '记忆纠正未接线：main.ts 未提供 onMemoryCorrect hook。' } })
          return
        }
        const at = new Date().toISOString()
        try {
          const mutation = normalizeMemoryAdminMutation(await hooks.onMemoryCorrect({ id, text, kind, namespace }), id)
          const entry: MemoryHistoryEntry = { at, action: 'correct', id, ok: mutation.ok, text, kind, namespace }
          if (mutation.documentId !== undefined) entry.documentId = mutation.documentId
          if (previousText !== '') entry.previousText = previousText
          if (mutation.note !== undefined) entry.note = mutation.note
          if (mutation.error !== undefined) entry.note = mutation.error
          await recordHistory(entry)
          reply(200, { ok: true, result: mutation })
        } catch (error) {
          const message = errorMessage(error)
          const entry: MemoryHistoryEntry = { at, action: 'correct', id, ok: false, text, kind, namespace, note: message }
          if (previousText !== '') entry.previousText = previousText
          await recordHistory(entry)
          reply(200, { ok: true, result: { ok: false, available: true, id, error: message } })
        }
        return
      }
      if (url.pathname === '/bot/memory/delete' && req.method === 'POST') {
        const body = await readBodyObject(req)
        const id = stringOf(body.id)
        const previousText = stringOf(body.previousText).slice(0, 8000)
        const kind = stringOf(body.kind) || 'fact'
        const namespace = stringOf(body.namespace) || 'global'
        if (id === '') { reply(200, errorPayload('INVALID_REQUEST', '需要记忆 id')); return }
        if (hooks.onMemoryDelete === undefined) {
          reply(200, { ok: true, result: { ok: false, available: false, id, note: '记忆删除未接线：main.ts 未提供 onMemoryDelete hook。' } })
          return
        }
        const at = new Date().toISOString()
        try {
          const mutation = normalizeMemoryAdminMutation(await hooks.onMemoryDelete({ id }), id)
          const entry: MemoryHistoryEntry = { at, action: 'delete', id, ok: mutation.ok, kind, namespace }
          if (previousText !== '') entry.text = previousText
          if (mutation.note !== undefined) entry.note = mutation.note
          if (mutation.error !== undefined) entry.note = mutation.error
          await recordHistory(entry)
          reply(200, { ok: true, result: mutation })
        } catch (error) {
          const message = errorMessage(error)
          const entry: MemoryHistoryEntry = { at, action: 'delete', id, ok: false, kind, namespace, note: message }
          if (previousText !== '') entry.text = previousText
          await recordHistory(entry)
          reply(200, { ok: true, result: { ok: false, available: true, id, error: message } })
        }
        return
      }
      if (url.pathname === '/bot/memory/history' && req.method === 'POST') {
        const body = await readBodyObject(req)
        const id = stringOf(body.id)
        const documentId = stringOf(body.documentId)
        const limit = clampInteger(body.limit, 50, 1, 200)
        const filter: { id?: string; documentId?: string; limit: number } = { limit }
        if (id !== '') filter.id = id
        if (documentId !== '') filter.documentId = documentId
        let local: MemoryHistoryEntry[] = []
        try { local = await readMemoryHistory(dshHome, filter) } catch { local = [] }
        let remote: MemoryHistoryEntry[] = []
        if (hooks.onMemoryHistory !== undefined && (id !== '' || documentId !== '')) {
          try {
            const query: BotMemoryHistoryQuery = { limit }
            if (id !== '') query.id = id
            if (documentId !== '') query.documentId = documentId
            remote = normalizeRemoteMemoryHistory(await hooks.onMemoryHistory(query))
          } catch { remote = [] }
        }
        reply(200, { ok: true, result: { entries: [...local, ...remote], localCount: local.length, remoteCount: remote.length } })
        return
      }
      if (url.pathname === '/bot/prompt/preview' && req.method === 'GET') {
        const config = await readConfig()
        if (hooks.onPromptPreview === undefined) {
          reply(200, { ok: true, result: normalizePromptPreview(null) })
          return
        }
        try {
          const result = normalizePromptPreview(await hooks.onPromptPreview(toBotConfigView(config)))
          result.wired = true
          reply(200, { ok: true, result })
        } catch (error) {
          reply(200, errorPayload('PROMPT_PREVIEW_FAILED', errorMessage(error)))
        }
        return
      }
      if (url.pathname === '/bot/config' && req.method === 'GET') { reply(200, { ok: true, config: toBotConfigView(await readConfig()) }); return }
      if (url.pathname === '/bot/config' && (req.method === 'PUT' || req.method === 'POST')) {
        const stored = await readConfig()
        const merged = mergeBotConfigEdit(stored, await readBody(req))
        const config = await writeConfig(merged)
        await hooks.onConfigSaved?.(config)
        reply(200, { ok: true, config: toBotConfigView(config) })
        return
      }
      if (url.pathname === '/bot/test/llm' && req.method === 'POST') {
        const stored = await readConfig()
        const body = await readBody(req).catch(() => ({})) as { llm?: Partial<BotConfig['llm']> }
        const merged = mergeBotConfigEdit(stored, { llm: { ...stored.llm, ...(body.llm || {}) } })
        const result: ProviderTestResult = await testLlmProvider(merged.llm, testDeps)
        reply(200, { ok: true, result })
        return
      }
      if (url.pathname === '/bot/test/voice' && req.method === 'POST') {
        const stored = await readConfig()
        const body = await readBody(req).catch(() => ({})) as { voice?: Partial<BotConfig['voice']> }
        const merged = mergeBotConfigEdit(stored, { voice: { ...stored.voice, ...(body.voice || {}) } })
        const result: ProviderTestResult = await testVoiceProvider(merged.voice, testDeps)
        reply(200, { ok: true, result })
        return
      }
      reply(404, { ok: false, error: 'not found' })
    } catch (error) {
      reply(500, { ok: false, error: errorMessage(error) })
    }
  })
  const actualPort = await new Promise<number>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address !== null ? address.port : port)
    })
  })
  return { port: actualPort, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
