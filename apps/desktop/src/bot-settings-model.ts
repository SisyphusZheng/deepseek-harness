/**
 * Shared data model for Bot settings (DSH Settings -> Bot, served by bot-config-server).
 *
 * Three concerns live here so both the HTTP service and the node tests can exercise them
 * without Electron:
 *  - the persisted BotConfig schema (backwards compatible normalization of old config.json;
 *    approval/permissions/behavior/persona.promptOverride are additive sections),
 *  - the memory admin contract normalization (list/correct/delete/history payloads coming
 *    from the optional main.ts hooks / sidecar), plus the local admin edit log
 *    (`<DSH_HOME>/memory/admin-history.jsonl`),
 *  - the assembled prompt preview normalization (DSH persona prompt + voice-mode prefix).
 *
 * Nothing here touches Electron or the network; every secret-bearing value is only ever
 * read from disk / written to disk and the browser view strips it.
 */
import { appendFile, chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { normalizeVoiceProviderId } from './bot-providers.ts'

/** How often the Bot asks the user before acting. */
export type BotApprovalMode = 'ask-each' | 'ask-before-acting' | 'ask-once' | 'never-ask'

/** Approval granularity choices offered by the settings page. */
export const BOT_APPROVAL_MODES: readonly BotApprovalMode[] = ['ask-each', 'ask-before-acting', 'ask-once', 'never-ask']

/** Default approval mode: matches the shipped `bot-outside-write` preset (approval: ask per action). */
export const DEFAULT_APPROVAL_MODE: BotApprovalMode = 'ask-each'

/** Default "approve once for N minutes" window. */
export const DEFAULT_APPROVAL_ONCE_MINUTES = 10
export const MIN_APPROVAL_ONCE_MINUTES = 1
export const MAX_APPROVAL_ONCE_MINUTES = 240

/** Persisted approval settings. */
export interface BotApprovalSettings {
  mode: BotApprovalMode
  onceMinutes: number
}

/** Persisted behaviour switches consumed by the Body Runtime / approval policy. */
export interface BotBehaviorSettings {
  pauseOnInput: boolean
  allowScreenView: boolean
}

/** Bot persona fields. `promptOverride` empty means "use the assembled default prompt". */
export interface BotPersona {
  name: string
  personality: string
  tone: string
  background: string
  quirks: string
  addressUser: string
  boundaries: string
  instructions: string
  promptOverride: string
}

/** The complete Bot config persisted at `<DSH_HOME>/bot/config.json` (mode 0600). */
export interface BotConfig {
  voice: { provider: string; baseUrl: string; apiKey: string; model: string; voice: string; wakeWord: string }
  llm: { provider: string; model: string; baseUrl: string; apiKey: string }
  agent: { mode: 'chat-only' | 'dsh'; workspace: string; session: string }
  persona: BotPersona
  app: { autoStart: boolean; keepRunning: boolean }
  memory: { enabled: boolean }
  approval: BotApprovalSettings
  behavior: BotBehaviorSettings
}

/** Browser-facing config: a stored secret becomes a presence boolean. */
export interface BotConfigView extends Omit<BotConfig, 'voice' | 'llm'> {
  voice: Omit<BotConfig['voice'], 'apiKey'> & { apiKeySet: boolean }
  llm: Omit<BotConfig['llm'], 'apiKey'> & { apiKeySet: boolean }
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  voice: { provider: 'dashscope', baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', apiKey: '', model: 'qwen-audio-3.0-realtime-plus', voice: 'longanxiaoxin', wakeWord: '' },
  llm: { provider: 'opencode-go', model: 'deepseek-v4.1-flash', baseUrl: '', apiKey: '' },
  agent: { mode: 'dsh', workspace: '', session: '' },
  persona: {
    name: 'Nisse（家灵）',
    personality: '自然、可靠，有一点鲸鱼娘的温柔与俏皮，但不过度卖萌；有自己的判断，不刻意迎合；做事干脆。',
    tone: '简短、清楚、不啰嗦；必要时先给结论。',
    background: '',
    quirks: '',
    addressUser: '',
    boundaries: '',
    instructions: '事实与执行结果必须来自 DSH；不编造执行结果。',
    promptOverride: '',
  },
  app: { autoStart: true, keepRunning: true },
  memory: { enabled: true },
  approval: { mode: DEFAULT_APPROVAL_MODE, onceMinutes: DEFAULT_APPROVAL_ONCE_MINUTES },
  behavior: { pauseOnInput: true, allowScreenView: false },
}

const CONFIG_FILE = 'config.json'

/** Clamp any stored string to the config text budget. */
export function clampText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 8000) : fallback
}

function sectionOf(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  const value = raw[name]
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/** Normalize an approval mode spelling to the four settings-page choices (unknown -> default). */
export function normalizeApprovalMode(value: unknown): BotApprovalMode {
  const raw = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (raw === 'ask-each' || raw === 'each' || raw === 'every-time' || raw === 'always') return 'ask-each'
  if (raw === 'ask-before-acting' || raw === 'before-acting' || raw === 'before_action' || raw === 'act') return 'ask-before-acting'
  if (raw === 'ask-once' || raw === 'once' || raw === 'ask-once-minutes') return 'ask-once'
  if (raw === 'never-ask' || raw === 'never' || raw === 'none') return 'never-ask'
  return DEFAULT_APPROVAL_MODE
}

/** Clamp the approval-once window to 1..240 whole minutes. */
export function clampOnceMinutes(value: unknown): number {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : Number.NaN
  if (!Number.isFinite(numeric)) return DEFAULT_APPROVAL_ONCE_MINUTES
  return Math.min(MAX_APPROVAL_ONCE_MINUTES, Math.max(MIN_APPROVAL_ONCE_MINUTES, Math.round(numeric)))
}

/** Normalize any stored/partial config into the current schema (older files keep every existing field). */
export function normalizeBotConfig(input: unknown): BotConfig {
  const raw = asRecord(input)
  const voice = sectionOf(raw, 'voice')
  const llm = sectionOf(raw, 'llm')
  const agent = sectionOf(raw, 'agent')
  const persona = sectionOf(raw, 'persona')
  const appSection = sectionOf(raw, 'app')
  const memorySection = sectionOf(raw, 'memory')
  const approvalSection = sectionOf(raw, 'approval')
  const behaviorSection = sectionOf(raw, 'behavior')
  return {
    voice: {
      provider: normalizeVoiceProviderId(clampText(voice.provider, DEFAULT_BOT_CONFIG.voice.provider)),
      baseUrl: clampText(voice.baseUrl, DEFAULT_BOT_CONFIG.voice.baseUrl),
      apiKey: clampText(voice.apiKey),
      model: clampText(voice.model, DEFAULT_BOT_CONFIG.voice.model),
      voice: clampText(voice.voice, DEFAULT_BOT_CONFIG.voice.voice),
      wakeWord: clampText(voice.wakeWord),
    },
    llm: {
      provider: clampText(llm.provider, DEFAULT_BOT_CONFIG.llm.provider),
      model: clampText(llm.model, DEFAULT_BOT_CONFIG.llm.model),
      baseUrl: clampText(llm.baseUrl, DEFAULT_BOT_CONFIG.llm.baseUrl),
      apiKey: clampText(llm.apiKey),
    },
    agent: {
      mode: agent.mode === 'chat-only' ? 'chat-only' : 'dsh',
      workspace: clampText(agent.workspace),
      session: clampText(agent.session),
    },
    persona: {
      name: clampText(persona.name, DEFAULT_BOT_CONFIG.persona.name),
      personality: clampText(persona.personality, DEFAULT_BOT_CONFIG.persona.personality),
      tone: clampText(persona.tone, DEFAULT_BOT_CONFIG.persona.tone),
      background: clampText(persona.background),
      quirks: clampText(persona.quirks),
      addressUser: clampText(persona.addressUser),
      boundaries: clampText(persona.boundaries),
      instructions: clampText(persona.instructions, DEFAULT_BOT_CONFIG.persona.instructions),
      promptOverride: clampText(persona.promptOverride),
    },
    app: {
      autoStart: appSection.autoStart !== false,
      keepRunning: appSection.keepRunning !== false,
    },
    memory: { enabled: memorySection.enabled !== false },
    approval: {
      mode: normalizeApprovalMode(approvalSection.mode),
      onceMinutes: clampOnceMinutes(approvalSection.onceMinutes),
    },
    behavior: {
      pauseOnInput: behaviorSection.pauseOnInput !== false,
      allowScreenView: behaviorSection.allowScreenView === true,
    },
  }
}

/** Strip secrets for the browser while preserving "a key is stored" semantics. */
export function toBotConfigView(config: BotConfig): BotConfigView {
  const { apiKey: voiceKey, ...voice } = config.voice
  const { apiKey: llmKey, ...llm } = config.llm
  return {
    ...config,
    voice: { ...voice, apiKeySet: voiceKey !== '' },
    llm: { ...llm, apiKeySet: llmKey !== '' },
  }
}

/** Merge one section while keeping the stored value when the edit omits it. */
function mergeSection(stored: Record<string, unknown>, edit: Record<string, unknown>, keys: readonly string[]): Record<string, unknown> {
  const merged: Record<string, unknown> = { ...stored }
  for (const key of keys) if (edit[key] !== undefined) merged[key] = edit[key]
  return merged
}

/**
 * Merge an edit over the stored config: an empty submitted secret keeps the stored one and
 * a partial section (e.g. only `persona.promptOverride`) keeps the other stored fields.
 */
export function mergeBotConfigEdit(stored: BotConfig, edit: unknown): BotConfig {
  const raw = asRecord(edit)
  const voice = sectionOf(raw, 'voice')
  const llm = sectionOf(raw, 'llm')
  const submittedVoiceKey = textOf(voice.apiKey)
  const submittedLlmKey = textOf(llm.apiKey)
  const merged: Record<string, unknown> = { ...stored, ...raw }
  merged.voice = { ...stored.voice, ...voice, apiKey: submittedVoiceKey === '' ? stored.voice.apiKey : submittedVoiceKey }
  merged.llm = { ...stored.llm, ...llm, apiKey: submittedLlmKey === '' ? stored.llm.apiKey : submittedLlmKey }
  merged.agent = mergeSection(stored.agent as unknown as Record<string, unknown>, sectionOf(raw, 'agent'), ['mode', 'workspace', 'session'])
  merged.persona = mergeSection(stored.persona as unknown as Record<string, unknown>, sectionOf(raw, 'persona'), [
    'name', 'personality', 'tone', 'background', 'quirks', 'addressUser', 'boundaries', 'instructions', 'promptOverride',
  ])
  merged.app = mergeSection(stored.app as unknown as Record<string, unknown>, sectionOf(raw, 'app'), ['autoStart', 'keepRunning'])
  merged.memory = mergeSection(stored.memory as unknown as Record<string, unknown>, sectionOf(raw, 'memory'), ['enabled'])
  merged.approval = mergeSection(stored.approval as unknown as Record<string, unknown>, sectionOf(raw, 'approval'), ['mode', 'onceMinutes'])
  merged.behavior = mergeSection(stored.behavior as unknown as Record<string, unknown>, sectionOf(raw, 'behavior'), ['pauseOnInput', 'allowScreenView'])
  return normalizeBotConfig(merged)
}

/** Read and normalize `<configDir>/config.json`; a missing/corrupt file falls back to defaults. */
export async function readBotConfigFile(configDir: string): Promise<BotConfig> {
  try {
    return normalizeBotConfig(JSON.parse(await readFile(join(configDir, CONFIG_FILE), 'utf8')))
  } catch {
    return structuredClone(DEFAULT_BOT_CONFIG)
  }
}

/** Atomically enough write of the config file with owner-only permissions; returns the stored config. */
export async function writeBotConfigFile(configDir: string, value: unknown): Promise<BotConfig> {
  const config = normalizeBotConfig(value)
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const file = join(configDir, CONFIG_FILE)
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
  return config
}

// ---------------------------------------------------------------------------
// Memory admin contract (list / correct / delete / history)
// ---------------------------------------------------------------------------

/** One memory row shown by the settings page. */
export interface MemoryAdminItem {
  id: string
  text: string
  kind: string
  namespace: string
  /** ISO-8601 timestamp as reported by the backend (may be empty). */
  date: string
  documentId?: string
  state?: string
}

/** Normalized list answer (works for raw sidecar JSON, hooks, or memory-runtime responses). */
export interface MemoryAdminList {
  available: boolean
  items: MemoryAdminItem[]
  total?: number
  hasMore: boolean
  note?: string
}

export interface BotMemoryListQuery {
  query?: string
  limit?: number
  offset?: number
  kind?: string
  namespace?: string
}

export interface BotMemoryCorrectInput {
  id: string
  text: string
  kind: string
  namespace: string
}

export interface BotMemoryDeleteInput {
  id: string
}

export interface BotMemoryHistoryQuery {
  id?: string
  documentId?: string
  limit?: number
}

/** Normalized result of a correct/delete hook. */
export interface MemoryAdminMutation {
  ok: boolean
  available: boolean
  id: string
  documentId?: string
  note?: string
  error?: string
  rollback?: unknown
  raw?: unknown
}

/** One local (settings-page) edit record persisted to `admin-history.jsonl`. */
export interface MemoryHistoryEntry {
  at: string
  action: 'correct' | 'delete' | 'create' | 'other'
  id: string
  documentId?: string
  text?: string
  previousText?: string
  kind?: string
  namespace?: string
  ok: boolean
  note?: string
  source?: 'local' | 'remote'
}

function firstString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    const text = textOf(value)
    if (text !== '') return text
  }
  return ''
}

/** Find the first array inside the tolerated hook shapes. */
function firstArray(values: unknown[]): unknown[] | null {
  for (const value of values) {
    if (Array.isArray(value)) return value
  }
  return null
}

function normalizeMemoryItem(value: unknown, index: number): MemoryAdminItem | null {
  const item = asRecord(value)
  const text = firstString(item.text, item.content, item.memory, item.value, item.fact)
  if (text === '') return null
  const id = firstString(item.id, item.memoryId, item.memory_id, item._id) || 'memory-' + String(index)
  const kind = firstString(item.kind, item.fact_type, item.type, item.category) || 'fact'
  const namespace = firstString(item.namespace, item.ns) || 'global'
  const date = firstString(item.date, item.mentionedAt, item.mentioned_at, item.createdAt, item.created_at, item.updatedAt, item.updated_at)
  const documentId = firstString(item.documentId, item.document_id)
  const state = firstString(item.state)
  return {
    id,
    text: text.slice(0, 8000),
    kind: kind.slice(0, 40),
    namespace: namespace.slice(0, 200),
    date: date.slice(0, 60),
    ...(documentId === '' ? {} : { documentId }),
    ...(state === '' ? {} : { state }),
  }
}

/**
 * Normalize a memory list answer from any tolerated source shape:
 * array | {items} | {memories} | {hits} | {result:{...}} | {json:{...}} (memory-runtime response).
 */
export function normalizeMemoryAdminList(raw: unknown, limit = 50): MemoryAdminList {
  const outer = asRecord(raw)
  const responseJson = asRecord(outer.json)
  const result = asRecord(outer.result)
  const wrapped = asRecord(result.result)
  const container = asRecord(responseJson.result)
  const array = firstArray([
    raw,
    outer.items,
    outer.memories,
    outer.hits,
    outer.list,
    result.items,
    result.memories,
    result.hits,
    responseJson.items,
    responseJson.memories,
    responseJson.hits,
    container.items,
    container.memories,
    container.hits,
    wrapped.items,
    result.list,
  ])
  if (array !== null) {
    const items: MemoryAdminItem[] = []
    for (let index = 0; index < array.length; index++) {
      const item = normalizeMemoryItem(array[index], index)
      if (item !== null) items.push(item)
    }
    const totalValue = Number(firstString(outer.total, result.total, responseJson.total, container.total))
    return {
      available: true,
      items,
      ...(Number.isFinite(totalValue) && totalValue > 0 ? { total: totalValue } : {}),
      hasMore: items.length >= Math.max(1, limit),
    }
  }
  if (outer.available === false || result.available === false || responseJson.available === false) {
    return {
      available: false,
      items: [],
      hasMore: false,
      note: firstString(result.note, outer.note, responseJson.note, result.error, outer.error),
    }
  }
  // An explicit {ok:true, items:[]} was covered above; anything else is "nothing to show".
  const note = firstString(result.note, outer.note, result.error, outer.error, asRecord(responseJson.error).message)
  return { available: raw !== undefined && raw !== null, items: [], hasMore: false, ...(note === '' ? {} : { note }) }
}

/** Normalize a correct/delete hook answer (sidesteps the nested sidecar / memory-runtime shapes). */
export function normalizeMemoryAdminMutation(raw: unknown, fallbackId = ''): MemoryAdminMutation {
  const outer = asRecord(raw)
  const responseJson = asRecord(outer.json)
  const innerCandidate = outer.result !== undefined
    ? asRecord(outer.result)
    : typeof responseJson.ok === 'boolean' ? responseJson : asRecord(responseJson.result)
  const inner = asRecord(innerCandidate)
  const okFlag = typeof outer.ok === 'boolean' ? outer.ok : typeof inner.ok === 'boolean' ? inner.ok : undefined
  const errorValue = outer.error !== undefined && outer.ok !== true
    ? outer.error
    : inner.error !== undefined ? inner.error : responseJson.error
  const error = firstString(
    typeof errorValue === 'string' ? errorValue : '',
    asRecord(errorValue).message,
    asRecord(errorValue).error,
    inner.message,
  )
  const ok = okFlag === undefined ? error === '' : okFlag !== false && error === ''
  const available = !(outer.available === false || inner.available === false)
  const documentId = firstString(inner.documentId, inner.document_id, outer.documentId, responseJson.documentId)
  const note = firstString(inner.note, outer.note, responseJson.note)
  const id = firstString(inner.previousId, inner.id, outer.id, responseJson.id) || fallbackId
  return {
    ok,
    available,
    id,
    ...(documentId === '' ? {} : { documentId }),
    ...(note === '' ? {} : { note }),
    ...(error === '' ? {} : { error }),
    ...(inner.rollback === undefined ? {} : { rollback: inner.rollback }),
    raw,
  }
}

/** Absolute path of the settings-page memory edit log. */
export function memoryHistoryFile(dshHome: string): string {
  return join(dshHome, 'memory', 'admin-history.jsonl')
}

/** Append one JSONL record to the settings-page memory edit log (owner-only file). */
export async function appendMemoryHistory(dshHome: string, entry: MemoryHistoryEntry): Promise<void> {
  const file = memoryHistoryFile(dshHome)
  await mkdir(join(dshHome, 'memory'), { recursive: true, mode: 0o700 })
  await appendFile(file, JSON.stringify(entry) + '\n', { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
}

/** Read the local memory edit log, newest first, optionally filtered to one memory/document. */
export async function readMemoryHistory(
  dshHome: string,
  filter: { id?: string; documentId?: string; limit?: number } = {},
): Promise<MemoryHistoryEntry[]> {
  let text = ''
  try {
    text = await readFile(memoryHistoryFile(dshHome), 'utf8')
  } catch {
    return []
  }
  const lines = text.split('\n')
  const entries: MemoryHistoryEntry[] = []
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    let parsed: unknown
    try { parsed = JSON.parse(trimmed) } catch { continue }
    const record = asRecord(parsed)
    const at = firstString(record.at, record.time, record.timestamp)
    if (at === '') continue
    const entry: MemoryHistoryEntry = {
      at,
      action: (record.action === 'correct' || record.action === 'delete' || record.action === 'create') ? record.action : 'other',
      id: firstString(record.id),
      ok: record.ok !== false,
      ...(firstString(record.documentId) === '' ? {} : { documentId: firstString(record.documentId) }),
      ...(firstString(record.text) === '' ? {} : { text: firstString(record.text) }),
      ...(firstString(record.previousText) === '' ? {} : { previousText: firstString(record.previousText) }),
      ...(firstString(record.kind) === '' ? {} : { kind: firstString(record.kind) }),
      ...(firstString(record.namespace) === '' ? {} : { namespace: firstString(record.namespace) }),
      ...(firstString(record.note) === '' ? {} : { note: firstString(record.note) }),
      source: 'local',
    }
    const filterActive = filter.id !== undefined || filter.documentId !== undefined
    const match = (filter.id !== undefined && entry.id === filter.id)
      || (filter.documentId !== undefined && entry.documentId === filter.documentId)
    if (filterActive && !match) continue
    entries.push(entry)
  }
  entries.reverse()
  const limit = typeof filter.limit === 'number' && Number.isFinite(filter.limit) ? Math.max(1, Math.min(500, Math.round(filter.limit))) : 50
  return entries.slice(0, limit)
}

/** Normalize an optional remote history answer (e.g. sidecar `/history` / native Hindsight history). */
export function normalizeRemoteMemoryHistory(raw: unknown): MemoryHistoryEntry[] {
  const outer = asRecord(raw)
  const responseJson = asRecord(outer.json)
  const array = firstArray([
    raw,
    outer.items,
    outer.entries,
    outer.history,
    responseJson.items,
    responseJson.entries,
    responseJson.history,
    asRecord(outer.result).items,
    asRecord(outer.result).entries,
    asRecord(outer.result).history,
  ])
  if (array === null) return []
  const entries: MemoryHistoryEntry[] = []
  for (const value of array) {
    const record = asRecord(value)
    const at = firstString(record.at, record.time, record.timestamp, record.createdAt, record.created_at, record.updatedAt)
    const actionText = firstString(record.action, record.op, record.event, record.type)
    const action: MemoryHistoryEntry['action'] = actionText === 'correct' ? 'correct' : actionText === 'delete' ? 'delete' : actionText === 'create' ? 'create' : 'other'
    const text = firstString(record.text, record.content, record.newText, record.value)
    const previousText = firstString(record.previousText, record.oldText, record.before)
    const id = firstString(record.id, record.memoryId, record.memory_id)
    if (at === '' && text === '' && id === '') continue
    entries.push({
      at: at || new Date(0).toISOString(),
      action,
      id,
      ok: record.ok !== false,
      text: text.slice(0, 8000),
      ...(previousText === '' ? {} : { previousText: previousText.slice(0, 8000) }),
      source: 'remote',
    })
  }
  return entries
}

// ---------------------------------------------------------------------------
// Assembled prompt preview
// ---------------------------------------------------------------------------

/** Read-only prompt preview shown by the settings page. */
export interface PromptPreview {
  /** True when main.ts wired the `onPromptPreview` hook. */
  wired: boolean
  /** True when at least one prompt body (or the proxy module path) came back. */
  available: boolean
  /** Assembled DSH persona prompt (host integration `/persona/preview` dshPrompt). */
  personaPrompt: string
  /** Voice-mode prompt prefix (qwen body runtime persona prefix). */
  voicePrefix: string
  /** Template placeholders detected in either prompt (`{{name}}`, `${...}`). */
  variables: string[]
  /** Provenance / engine hints (path of the voice persona module, override presence...). */
  sources: Record<string, string>
  note?: string
}

const PLACEHOLDER_RE = /\{\{[^{}]{1,120}\}\}|\$\{[A-Za-z0-9_.:-]{1,120}\}/g

function placeholdersOf(...texts: string[]): string[] {
  const found = new Set<string>()
  for (const text of texts) {
    if (text === '') continue
    const matches = text.match(PLACEHOLDER_RE) ?? []
    for (const match of matches) found.add(match)
  }
  return [...found].slice(0, 50)
}

/**
 * Normalize a prompt preview answer. Tolerated shapes: `{personaPrompt|dshPrompt, voicePrefix}`,
 * host-integration `/persona/preview` (`{dshPrompt, promptOverride, voicePersonaModule}`),
 * a bare prompt string, or `{prompt}`.
 */
export function normalizePromptPreview(raw: unknown): PromptPreview {
  const empty: PromptPreview = { wired: false, available: false, personaPrompt: '', voicePrefix: '', variables: [], sources: {} }
  if (raw === null || raw === undefined) return { ...empty, note: '提示词预览未接线：需要在 main.ts 传入 onPromptPreview hook。' }
  if (typeof raw === 'string') {
    return { wired: true, available: raw.trim() !== '', personaPrompt: raw.slice(0, 20000), voicePrefix: '', variables: placeholdersOf(raw), sources: {} }
  }
  const outer = asRecord(raw)
  const responseJson = asRecord(outer.json)
  const result = asRecord(outer.result)
  const body = Object.keys(result).length > 0 ? result : Object.keys(responseJson).length > 0 ? responseJson : outer
  const personaPrompt = firstString(
    body.personaPrompt, body.dshPrompt, body.persona, body.prompt, body.systemPrompt, body.assembled,
  ).slice(0, 20000)
  const voicePrefix = firstString(body.voicePrefix, body.voicePrompt, body.voicePersonaPrefix, body.voice, body.qwenPrefix).slice(0, 20000)
  const sources: Record<string, string> = {}
  const voiceModule = firstString(body.voicePersonaModule, asRecord(body.sources).voicePersonaModule)
  if (voiceModule !== '') sources.voicePersonaModule = voiceModule
  const promptOverride = firstString(body.promptOverride)
  if (promptOverride !== '') sources.promptOverride = 'active'
  for (const [key, value] of Object.entries(asRecord(body.sources))) {
    const text = textOf(value)
    if (text !== '') sources[key] = text
  }
  const variables = Array.isArray(body.variables)
    ? body.variables.map(item => textOf(item)).filter(item => item !== '').slice(0, 50)
    : placeholdersOf(personaPrompt, voicePrefix)
  const available = personaPrompt !== '' || voicePrefix !== '' || Object.keys(sources).length > 0
  const note = firstString(body.note, outer.note)
  const preview: PromptPreview = { wired: true, available, personaPrompt, voicePrefix, variables, sources }
  if (note !== '') preview.note = note
  else if (!available) preview.note = '提示词预览返回为空。'
  return preview
}
