// Nisse Host Integration v0 (M3) — product bundle, first-party. Ported from the M1 voice fixture;
// maps DSH turn/events/approval/cancel to the internal Product Contract (v0).
// NOT the product Host Integration. Source pattern copied from dsh-nisse v0.6.0
// (`ctx.agents.create` + `agent.followup` + `agent/assistant-stream`), reduced to
// the single text-turn path plus the durable `session/event` subscription.
//
// What it does:
//  - creates ONE dedicated DSH agent session (never attaches to a user session),
//  - submits a user message with the official `createUserMessage` constructor,
//  - records durable turn/tool events + token-level assistant deltas,
//  - exposes a tiny localhost HTTP bridge (token-auth) for the M1 harness:
//      GET  /health, POST /turn, GET /events?after=<ioSeq>
//  - W2: also speaks the dsh-nisse bridge protocol subset that the real Qwen
//    voice runtime (research/qwen-audio-agent server/src/voice/nisse-bridge-client.mjs)
//    already uses, so the voice stack can be integration-tested without code changes:
//      POST /sessions/create, POST /turn, GET /events (SSE), POST /cancel,
//      POST /approval, GET/PUT /config, GET/POST/DELETE /policies
//  - writes `bridge.json` (pid/port/token) into the isolated bridge dir only.
//
// It runs in a throw-away DSH host under /tmp/nisse-m1 with its own
// DSH_HOME/HOME; it never reads or writes ~/.dsh, ~/Documents/Nisse, or the
// installed Nisse/DSH profile.
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const name = 'nisse-host-integration'
export const inject = ['agents']

const CONTRACT_EVENT_MAP = {
  'user.message': 'turn.started',
  'assistant.delta': 'turn.delta',
  'assistant.message': 'turn.delta',
  'tool.call': 'turn.tool',
  'tool.result': 'turn.tool',
  'approval.request': 'turn.approval',
  'approval.decided': 'approval.decided',
  'agent.status': 'turn.settled',
  'turn.ended': 'turn.settled',
  'error': 'error',
  'agent.error': 'error',
}
function contractTypeFor(type) { return CONTRACT_EVENT_MAP[type] || 'system.event' }
const FIXTURE = 'nisse-host-integration'
const VERSION = '0.1.0'
const CONTRACT_VERSION = 'v0'
const DEFAULT_PERSONA = {
  name: 'Nisse',
  personality: '自然、可靠，有一点鲸鱼娘的温柔与俏皮，但不过度卖萌；有自己的判断，不刻意迎合；做事干脆。',
  tone: '简短、清楚、不啰嗦；必要时先给结论。',
  instructions: '事实性回答与任务结果必须来自 DSH；不编造执行结果。',
}
function normalizePersona(input) {
  const p = input && typeof input === 'object' ? input : {}
  const pick = (v, fallback, max) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : fallback)
  return {
    name: pick(p.name, DEFAULT_PERSONA.name, 80),
    personality: pick(p.personality, DEFAULT_PERSONA.personality, 1200),
    tone: pick(p.tone, DEFAULT_PERSONA.tone, 800),
    instructions: pick(p.instructions, DEFAULT_PERSONA.instructions, 2000),
  }
}
function personaText(persona) {
  const p = persona || DEFAULT_PERSONA
  return [
    '你是 Nisse（家灵），一个桌面个人 Agent。',
    '名字：' + p.name,
    '性格：' + p.personality,
    '语气：' + p.tone,
    '约束：' + p.instructions,
    '只根据 DSH 提供的事实与执行结果说话；不虚构工具执行、文件内容或任务结果。',
  ].join('\n')
}
const BRIDGE_PROTOCOL = 'dsh-nisse-subset-v0'
const MAX_EVENTS = 5000
const MAX_BRIDGE_FRAMES = 400

// The W1 spec requires the OFFICIAL user-message constructor, not a hand-built
// message. Profile plugins cannot resolve `@deepseek-ai/*` by bare specifier
// (they have no node_modules chain into the installation), so load the exact
// installed module by its absolute asar path, supplied by run.sh.
const DEFAULT_LLM_ENTRY = join(dirname(fileURLToPath(import.meta.url)), '../../../../packages/llm/llm/lib/index.js')
const OFFICIAL_LLM_ENTRY = String(
  process.env.NISSE_DSH_LLM_ENTRY
  || process.env.NISSE_M1_DSH_LLM
  || DEFAULT_LLM_ENTRY,
).trim()
let createUserMessage = null
let officialConstructorSource = ''
if (OFFICIAL_LLM_ENTRY) {
  try {
    const llm = await import(pathToFileURL(OFFICIAL_LLM_ENTRY).href)
    if (typeof llm.createUserMessage === 'function') {
      createUserMessage = llm.createUserMessage
      officialConstructorSource = OFFICIAL_LLM_ENTRY
    }
  } catch (error) {
    console.log('[nisse-host-integration] official constructor import failed: ' + String(error?.message || error))
  }
}
if (typeof createUserMessage !== 'function') {
  throw new Error(
    'nisse-host-integration: refusing to run without the official createUserMessage '
    + '(NISSE_M1_DSH_LLM=' + (OFFICIAL_LLM_ENTRY || '<unset>') + ')',
  )
}

const now = () => new Date().toISOString()

function json(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 256 * 1024) {
        reject(new Error('body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      if (!raw) return resolve({})
      try { resolve(JSON.parse(raw)) } catch (error) { reject(error) }
    })
    req.on('error', reject)
  })
}

const messageOf = (error) => String(error?.message || error || 'unknown error')

function preview(value, max = 200) {
  let text
  try { text = typeof value === 'string' ? value : JSON.stringify(value) } catch { text = String(value) }
  text = text || ''
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function summarizeToolData(data) {
  const record = data || {}
  return {
    callId: record.callId || record.id || null,
    name: record.name || record.toolName || null,
    argumentsPreview: preview(record.arguments ?? record.args ?? record.input ?? ''),
    resultPreview: preview(record.result ?? record.output ?? ''),
    isError: Boolean(record.isError),
  }
}

export function loadPersona() {
  try {
    const file = join(String(process.env.DSH_HOME || '/tmp/dsh-home'), 'nisse', 'persona.json')
    if (!existsSync(file)) return normalizePersona(DEFAULT_PERSONA)
    return normalizePersona(JSON.parse(readFileSync(file, 'utf8')))
  } catch { return normalizePersona(DEFAULT_PERSONA) }
}

export function apply(ctx, config = {}) {
  const dshHome = String(process.env.DSH_HOME || '/tmp/dsh-home')
  const bridgeDir = String(config.ipcDir || process.env.NISSE_IPC_DIR || join(dshHome, 'nisse'))
  const workspaceDir = String(config.workspaceDir || process.env.NISSE_WORKSPACE || join(dshHome, 'workspace'))
  const provider = String(config.provider || process.env.NISSE_M1_PROVIDER || '').trim()
  const model = String(config.model || process.env.NISSE_M1_MODEL || '').trim()
  const reasoningEffort = String(config.reasoningEffort || process.env.NISSE_M1_REASONING_EFFORT || '').trim()
  const memoryUrl = String(config.memoryUrl || process.env.NISSE_MEMORY_URL || '').replace(/\/$/, '')
  const memoryToken = String(config.memoryToken || process.env.NISSE_MEMORY_TOKEN || '')
  const hostPid = process.pid
  const startedAt = now()
  const token = randomUUID()
  const bridgeFile = join(bridgeDir, 'host-integration.json')

  mkdirSync(bridgeDir, { recursive: true })
  mkdirSync(workspaceDir, { recursive: true })

  const events = []
  const seenDurable = new Set()
  let ioSeq = 0
  let durableSeq = 0
  let handle = null
  let agent = null
  let sessionId = ''
  let currentTurn = null
  let lastTurn = null
  let turnCount = 0
  let submitted = 0
  let submittedText = ''
  // W2 bridge subset: the voice client scopes a turn with its own client turn id.
  let activeClientTurnId = ''
  const bridgeFrames = []
  let bridgeSeq = 0
  const sseSubscribers = new Set()
  const policies = []
  const personaFile = join(bridgeDir, 'persona.json')
  const auditFile = join(bridgeDir, 'audit.jsonl')
  const auditEvents = []
  let persona = loadPersona()
  const pendingApprovals = new Map()
  let approvalSeq = 0

  const log = (...args) => {
    try { console.log('[nisse-host-integration]', ...args) } catch { /* ignore */ }
  }

  function auditEvent(event, fields = {}) {
    const record = { ts: now(), event, ...fields }
    auditEvents.push(record)
    if (auditEvents.length > 2000) auditEvents.splice(0, auditEvents.length - 2000)
    try { appendFileSync(auditFile, JSON.stringify(record) + '\n') } catch (error) { log('audit append failed: ' + messageOf(error)) }
    return record
  }

  function prunePolicies() {
    const t = Date.now()
    for (let i = policies.length - 1; i >= 0; i -= 1) {
      if (policies[i].expiresAt && Date.parse(policies[i].expiresAt) <= t) policies.splice(i, 1)
    }
  }

  async function memoryRequest(method, path, body) {
    if (!memoryUrl) throw new Error('memory backend not configured')
    const res = await fetch(memoryUrl + path, {
      method,
      headers: { authorization: 'Bearer ' + memoryToken, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(120000),
    })
    const json = await res.json().catch(() => null)
    if (!res.ok || json?.ok === false) {
      const error = new Error(json?.error?.message || `memory backend http ${res.status}`)
      error.code = json?.error?.code || 'MEMORY_UNAVAILABLE'
      throw error
    }
    return json
  }

  async function memoryDigest() {
    if (!memoryUrl) return ''
    try {
      const result = await memoryRequest('POST', '/digest', { budgetTokens: 500 })
      const text = result?.digest?.text || result?.digest?.content || ''
      return typeof text === 'string' ? text.slice(0, 4000) : ''
    } catch (error) { log('memory digest unavailable: ' + messageOf(error)); return '' }
  }

  function activePolicy(toolName, reason) {
    prunePolicies()
    return policies.find((rule) => {
      if (rule.toolName !== toolName) return false
      if (rule.pathPrefix && !String(reason || '').includes(rule.pathPrefix)) return false
      if (rule.reasonPattern && !String(reason || '').includes(rule.reasonPattern)) return false
      return true
    }) || null
  }

  function push(type, fields = {}) {
    ioSeq += 1
    const sid = fields.sessionId ?? sessionId
    const turn = fields.turn ?? currentTurn
    const turnId = fields.turnId ?? (sid && turn != null ? `${sid}:${turn}` : null)
    const record = {
      ioSeq,
      ts: now(),
      component: 'integration',
      type,
      contractType: contractTypeFor(type),
      contractVersion: CONTRACT_VERSION,
      sessionId: sid || null,
      turn: turn ?? null,
      turnId,
      data: fields.data || {},
      note: fields.note || '',
    }
    events.push(record)
    if (events.length > MAX_EVENTS) events.splice(0, events.length - MAX_EVENTS)
    broadcastBridge(record)
    return record
  }

  // ---- W2: dsh-nisse bridge protocol subset (for the real Qwen voice stack) ----
  // Frames are what `NisseBridgeClient.runTurn()` consumes: user.message marks
  // the turn active, assistant.delta streams tokens, agent.status idle settles.
  function bridgeFramesFor(record) {
    const turnScope = activeClientTurnId ? { turnId: activeClientTurnId } : {}
    const data = record.data || {}
    switch (record.type) {
      case 'turn.accepted':
        return [{ ...turnScope, type: 'user.message', text: submittedText }]
      case 'agent.status':
        return [{ ...turnScope, type: 'agent.status', status: data.status || 'idle' }]
      case 'assistant.stream.started':
        return [{ ...turnScope, type: 'assistant.start', attemptId: data.attemptId, turn: record.turn, step: data.step }]
      case 'assistant.delta':
        return [{ ...turnScope, type: 'assistant.delta', text: data.text, index: data.index }]
      case 'assistant.stream.ended':
        return [{ ...turnScope, type: 'assistant.end', outcome: data.outcome }]
      case 'tool.delta':
        return [{ ...turnScope, type: 'tool.delta', name: data.name, id: data.callId }]
      case 'approval.request':
        return [{ ...turnScope, type: 'approval', id: data.id || null, toolName: data.toolName || '', reason: data.reason || '', callId: data.callId || null }]
      case 'error':
        return [{ ...turnScope, type: 'agent.error', message: data.message || 'error' }]
      case 'turn.ended':
        if (data.terminal && data.terminal !== 'completed') {
          return [{ ...turnScope, type: 'agent.error', message: String(data.reason?.error?.message || data.terminal) }]
        }
        return []
      default:
        return []
    }
  }

  function broadcastBridge(record) {
    let frames
    try { frames = bridgeFramesFor(record) } catch { frames = [] }
    for (const frame of frames) {
      bridgeSeq += 1
      bridgeFrames.push(frame)
      if (bridgeFrames.length > MAX_BRIDGE_FRAMES) bridgeFrames.shift()
      for (const subscriber of sseSubscribers) {
        try {
          subscriber.res.write('data: ' + JSON.stringify(frame) + '\n\n')
        } catch {
          sseSubscribers.delete(subscriber)
        }
      }
    }
  }

  const matchesSession = (id) => Boolean(sessionId) && String(id || '') === sessionId

  function recordDurable(session, event) {
    if (!event || typeof event.type !== 'string') return
    const sid = session?.id
      ? String(session.id)
      : matchesSession(event.sessionId) ? event.sessionId : ''
    if (!matchesSession(sid)) return
    if (typeof event.seq === 'number') {
      if (seenDurable.has(event.seq)) return
      seenDurable.add(event.seq)
      if (event.seq > durableSeq) durableSeq = event.seq
    }
    const data = event.data || {}
    const turn = Number.isInteger(data.turn) ? data.turn : currentTurn
    const base = { sessionId: sid, turn: turn ?? null, turnId: turn == null ? null : `${sid}:${turn}` }
    switch (event.type) {
      case 'turn/start':
        currentTurn = data.turn
        turnCount = Math.max(turnCount, data.turn || 0)
        push('turn.started', { ...base, data: { durableSeq: event.seq } })
        break
      case 'turn/end': {
        const reason = data.reason || {}
        lastTurn = { turn: data.turn, terminal: String(reason.kind || 'unknown'), reason }
        push('turn.ended', {
          ...base,
          data: { durableSeq: event.seq, terminal: String(reason.kind || 'unknown'), reason },
        })
        currentTurn = null
        break
      }
      case 'step/start':
        push('step.started', { ...base, data: { durableSeq: event.seq, step: data.step } })
        break
      case 'step/end':
        push('step.ended', { ...base, data: { durableSeq: event.seq, step: data.step } })
        break
      case 'tool/call':
        push('tool.call', { ...base, data: { durableSeq: event.seq, ...summarizeToolData(data) } })
        break
      case 'tool/result':
        push('tool.result', { ...base, data: { durableSeq: event.seq, ...summarizeToolData(data) } })
        break
      case 'user/message':
        push('user.message', { ...base, data: { durableSeq: event.seq } })
        break
      case 'assistant/message':
        push('assistant.message', { ...base, data: { durableSeq: event.seq } })
        break
      case 'approval/asked':
        // The approval/request handler pushes a richer approval.request event
        // (id/reason/callId). Do not also emit an id-less durable event: the voice
        // bridge would treat both as separate approval requests and the first one
        // (without an id) cannot be answered.
        break
      case 'approval/decided':
        push('approval.decided', { ...base, data: { durableSeq: event.seq, outcome: data.outcome || null } })
        break
      default:
        break // keep the W1 log focused; the full durable log stays in the isolated session store
    }
  }

  // Durable `session/event` observer (token-level frames arrive through
  // `agent/assistant-stream`; turn boundaries come from the durable log).
  if (typeof ctx.on === 'function') {
    ctx.on('session/event', (...args) => {
      try {
        const first = args[0]
        const second = args[1]
        if (second?.type) return recordDurable(first, second)
        if (first?.event?.type) return recordDurable(first.session, first.event)
        if (first?.type && first?.seq != null) return recordDurable(null, first)
      } catch (error) {
        log('session/event handler failed: ' + messageOf(error))
      }
    })

    ctx.on('agent/assistant-stream', (payload) => {
      try {
        const sid = payload?.agent?.session?.id
        if (!matchesSession(sid)) return
        const frame = payload?.frame || {}
        const turn = Number.isInteger(frame.turn) ? frame.turn : currentTurn
        if (frame.type === 'start') {
          push('assistant.stream.started', { sessionId: sid, turn, data: { attemptId: frame.attemptId, step: frame.step } })
          return
        }
        if (frame.type === 'end') {
          push('assistant.stream.ended', { sessionId: sid, turn, data: { outcome: frame.outcome?.kind || 'unknown' } })
          return
        }
        if (frame.type !== 'chunk') return
        const chunk = frame.chunk || {}
        if (chunk.type === 'text-delta') {
          push('assistant.delta', {
            sessionId: sid,
            turn,
            data: { text: chunk.text, index: frame.index, attemptId: frame.attemptId },
          })
        } else if (chunk.type === 'tool-call-delta') {
          push('tool.delta', { sessionId: sid, turn, data: { name: chunk.name || '', callId: chunk.id || null } })
        } else if (chunk.type === 'usage') {
          push('assistant.usage', {
            sessionId: sid,
            turn,
            data: { usage: chunk.usage ?? chunk, rawKeys: Object.keys(chunk) },
          })
        }
      } catch (error) {
        log('assistant-stream handler failed: ' + messageOf(error))
      }
    })

    ctx.on('agent/status', (payload) => {
      try {
        const sid = payload?.agent?.session?.id
        if (!matchesSession(sid)) return
        push('agent.status', { sessionId: sid, data: { status: payload.status } })
        if (payload.status === 'idle') backfill()
      } catch (error) {
        log('agent/status handler failed: ' + messageOf(error))
      }
    })

    ctx.on('agent/error', (payload) => {
      try {
        const sid = payload?.agent?.session?.id
        if (!matchesSession(sid)) return
        push('error', { sessionId: sid, data: { message: messageOf(payload?.error) } })
      } catch { /* ignore */ }
    })

    // W1 optional tool probe: answer approvals for THIS isolated session only,
    // and only for the read-only model-facing `read` tool. Everything else is
    // delegated (fail-closed as in production). The durable approval/asked and
    // approval/decided events are recorded through the session/event observer.
    ctx.on('approval/request', (req, next) => {
      try {
        const sid = req?.agent?.session?.id
        if (!matchesSession(sid)) return next()
        const toolName = String(req?.toolName || '')
        log('approval/request', { sessionId: sid, toolName })
        // Read probes are auto-allowed. All other tools are surfaced to the
        // voice bridge so a real approval round-trip can be tested (T7).
        if (toolName === 'read') return 'allowed-once'
        const reason = String(req?.reason || '')
        const policy = activePolicy(toolName, reason)
        if (policy) {
          auditEvent('policy.auto_allow', { policyId: policy.id, toolName, reason: preview(reason) })
          log('approval auto-allowed by policy', { policyId: policy.id, toolName })
          return 'allowed-once'
        }
        const id = 'approval_' + Date.now() + '_' + (++approvalSeq)
        const callId = req?.callId || null
        push('approval.request', { data: { id, toolName, reason, callId } })
        auditEvent('approval.requested', { approvalId: id, toolName, reason: preview(reason), callId })
        log('approval pending', { id, toolName, reason: preview(reason) })
        return new Promise(resolve => {
          const timer = setTimeout(() => {
            pendingApprovals.delete(id)
            log('approval timeout', { id, toolName })
            resolve(next())
          }, 120000)
          pendingApprovals.set(id, { resolve, timer, toolName, reason, callId })
        })
      } catch (error) {
        log('approval handler failed: ' + messageOf(error))
        return next()
      }
    })
  } else {
    log('ctx.on unavailable; durable events will only be backfilled on idle')
  }

  function backfill() {
    try {
      const session = agent?.session
      if (!session || typeof session.snapshotEvents !== 'function') return
      for (const event of session.snapshotEvents()) recordDurable(session, event)
    } catch (error) {
      log('backfill failed: ' + messageOf(error))
    }
  }

  async function ensureAgent() {
    if (agent) return agent
    if (typeof ctx.agents?.create !== 'function') throw new Error('ctx.agents.create is unavailable')
    const defaultSelection = ctx.get?.('agentDefaultModel')?.currentSelection?.() || null
    const agentOptions = provider && model
      ? { provider, model, ...(reasoningEffort ? { reasoningEffort } : {}) }
      : defaultSelection?.provider && defaultSelection?.model
        ? { provider: defaultSelection.provider, model: defaultSelection.model, ...(reasoningEffort ? { reasoningEffort } : {}) }
        : undefined
    const requestedSessionId = sessionId || randomUUID()
    const digest = await memoryDigest()
    const personaSetup = agentCtx => {
      try {
        const systemPrompt = agentCtx?.systemPrompt
        if (typeof systemPrompt?.section === 'function') {
          systemPrompt.section({ name: 'nisse-persona', order: 120, text: personaText(persona), interpolate: false })
          if (digest) systemPrompt.section({ name: 'nisse-memory', order: 130, text: '长期记忆摘要：\n' + digest, interpolate: false })
        }
      } catch (error) {
        log('persona prompt section registration failed: ' + messageOf(error))
      }
    }
    let created
    try {
      created = await ctx.agents.create({
        sessionId: requestedSessionId,
        meta: { cwd: workspaceDir, agentPreset: 'standard' },
        ...(agentOptions ? { agentOptions } : {}),
        setup: personaSetup,
      })
    } catch (error) {
      // Persona refresh disposes the live agent and re-creates the SAME session;
      // DSH rejects create for an existing id, so resume the persisted session
      // with the new agent-scoped prompt section.
      if (typeof ctx.agents.resume === 'function' && /already exists/i.test(String(error?.message || error))) {
        created = await ctx.agents.resume({
          resumeSessionId: requestedSessionId,
          ...(agentOptions ? { agentOptions } : {}),
          setup: personaSetup,
        })
      } else {
        throw error
      }
    }
    handle = created
    agent = created.agent
    sessionId = String(agent.session.id)
    push('agent.created', {
      sessionId,
      data: {
        requestedSessionId,
        actualSessionId: sessionId,
        cwd: String(agent.session?.header?.cwd || workspaceDir),
        agentOptions: agentOptions || null,
        defaultSelection,
      },
    })
    log('agent created', { sessionId, agentOptions: agentOptions || null, workspace: workspaceDir })
    return agent
  }

  async function submitTurn(text, { clientTurnId = '' } = {}) {
    const trimmed = String(text || '').trim()
    if (!trimmed) throw new Error('text required')
    await ensureAgent()
    lastTurn = null
    submitted += 1
    submittedText = trimmed
    activeClientTurnId = String(clientTurnId || '').trim().slice(0, 200)
    const message = createUserMessage({
      content: [{ type: 'text', text: trimmed }],
      source: { kind: 'user' },
    })
    push('turn.accepted', {
      sessionId,
      data: { chars: trimmed.length, messageId: message.id, constructor: 'createUserMessage', clientTurnId: activeClientTurnId || null },
    })
    agent.followup(message)
    return { sessionId, messageId: message.id }
  }

  async function cancelTurn() {
    if (!agent) return { ok: true, cancelled: false, sessionId: sessionId || '', settledApprovals: 0 }
    if (String(agent.status || 'idle') === 'idle') {
      return { ok: true, cancelled: false, sessionId: sessionId || '', settledApprovals: 0 }
    }
    let cancelled = false
    try {
      agent.cancel?.({ kind: 'user' })
      cancelled = true
    } catch (error) {
      log('agent cancel failed: ' + messageOf(error))
    }
    if (cancelled) {
      try {
        await Promise.race([
          Promise.resolve(agent.whenIdle?.()).catch(() => {}),
          new Promise((resolve) => setTimeout(resolve, 5000)),
        ])
      } catch { /* ignore */ }
      if (String(agent.status || 'idle') !== 'idle') {
        push('agent.status', { sessionId, data: { status: 'idle', synthesized: true } })
      }
    }
    return { ok: true, cancelled, sessionId: sessionId || '', settledApprovals: 0 }
  }

  function health() {
    return {
      ok: true,
      fixture: FIXTURE,
      contractVersion: CONTRACT_VERSION,
      pluginVersion: VERSION,
      version: VERSION,
      pid: hostPid,
      startedAt,
      services: {
        agents: Boolean(ctx.agents?.create),
        session: Boolean(ctx.get?.('session')),
        approval: Boolean(ctx.get?.('approval')),
        tools: Boolean(ctx.get?.('tools')),
        memory: Boolean(memoryUrl),
      },
      paths: {
        dshHome: String(process.env.DSH_HOME || ''),
        home: String(process.env.HOME || ''),
        profile: String(process.env.NISSE_M1_PROFILE || process.env.DSH_PROFILE || ''),
        cwd: process.cwd(),
        bridgeDir,
        workspaceDir,
      },
      agent: {
        sessionId: sessionId || null,
        created: Boolean(agent),
        status: String(agent?.status || 'idle'),
        lastTurn,
      },
      counts: { events: events.length, submitted, turns: turnCount, durableSeq, bridgeFrames: bridgeFrames.length, sseSubscribers: sseSubscribers.size },
      eventTypes: [...new Set(events.map((event) => event.type))],
      bridge: {
        protocol: BRIDGE_PROTOCOL,
        clientTurnId: activeClientTurnId || null,
        compatible: ['/sessions/create', '/turn', '/events(SSE)', '/cancel', '/approval', '/config', '/policies'],
      },
      messageConstructor: {
        name: 'createUserMessage',
        source: officialConstructorSource,
      },
    }
  }

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/health' && req.method === 'GET') return json(res, 200, health())
      const auth = String(req.headers.authorization || '')
      const queryToken = String(url.searchParams.get('token') || '')
      const sseRequest = url.pathname === '/events'
        && (url.searchParams.has('sessionId') || String(req.headers.accept || '').includes('text/event-stream'))
      const authorized = auth === `Bearer ${token}` || (sseRequest && queryToken === token)
      if (!authorized) return json(res, 401, { error: 'unauthorized' })

      // ---- dsh-nisse bridge protocol subset (for the real Qwen voice client) ----
      if (url.pathname === '/history' && req.method === 'GET') {
        const limit = Math.min(200, Math.max(1, Number(url.searchParams.get('limit') || 50)))
        const interesting = new Set(['user.message', 'assistant.message', 'tool.call', 'tool.result', 'turn.ended', 'approval.request', 'approval.decided', 'error'])
        const items = events
          .filter((event) => interesting.has(event.type))
          .slice(-limit)
          .map((event) => ({
            ioSeq: event.ioSeq,
            ts: event.ts,
            turn: event.turn,
            turnId: event.turnId,
            type: event.type,
            contractType: event.contractType,
            summary: event.type === 'tool.call' || event.type === 'tool.result'
              ? summarizeToolData(event.data)
              : preview(event.data?.text || event.data?.content || event.data?.outcome || event.data?.status || ''),
          }))
        return json(res, 200, { ok: true, count: items.length, events: items })
      }
      if (url.pathname === '/persona' && req.method === 'GET') {
        return json(res, 200, { ok: true, persona })
      }
      if (url.pathname === '/persona' && req.method === 'POST') {
        const body = await readBody(req)
        persona = normalizePersona(body)
        try {
          mkdirSync(bridgeDir, { recursive: true })
          writeFileSync(personaFile, JSON.stringify(persona, null, 2) + '\n')
        } catch (error) { log('persona persist failed: ' + messageOf(error)) }
        // Persona is an agent-scoped prompt section; dispose the live agent so the
        // next turn recreates/resumes the session with the new section.
        try {
          const oldSession = sessionId
          await handle?.dispose?.()
          agent = null
          handle = null
          sessionId = oldSession
          log('persona updated; agent disposed for refresh', { sessionId: oldSession })
        } catch (error) { log('persona agent dispose failed: ' + messageOf(error)) }
        auditEvent('persona.changed', { name: persona.name })
        return json(res, 200, { ok: true, persona, applied: 'next-turn' })
      }
      if (url.pathname === '/audit' && req.method === 'GET') {
        const limit = Math.min(1000, Math.max(1, Number(url.searchParams.get('limit') || 200)))
        return json(res, 200, { ok: true, count: auditEvents.length, events: auditEvents.slice(-limit) })
      }
      if (url.pathname.startsWith('/memory/') && req.method === 'GET') {
        try { return json(res, 200, await memoryRequest('GET', url.pathname.slice('/memory'.length))) }
        catch (error) { return json(res, 503, { ok: false, error: { code: error.code || 'MEMORY_UNAVAILABLE', message: messageOf(error) } }) }
      }
      if (url.pathname.startsWith('/memory/') && req.method === 'POST') {
        const body = await readBody(req)
        try { return json(res, 200, await memoryRequest('POST', url.pathname.slice('/memory'.length), body)) }
        catch (error) { return json(res, 503, { ok: false, error: { code: error.code || 'MEMORY_UNAVAILABLE', message: messageOf(error) } }) }
      }
      if (url.pathname === '/sessions/create' && req.method === 'POST') {
        await readBody(req).catch(() => ({}))
        await ensureAgent()
        return json(res, 200, {
          sessionId,
          actualSessionId: sessionId,
          created: true,
          workspace: workspaceDir,
          model: { provider, model },
          reasoningEffort: '',
          personaSection: false,
        })
      }
      if (url.pathname === '/config' && req.method === 'GET') {
        return json(res, 200, {
          ok: true,
          fixture: FIXTURE,
      contractVersion: CONTRACT_VERSION,
      pluginVersion: VERSION,
          protocol: BRIDGE_PROTOCOL,
          persona: { name: 'Nisse（fixture）' },
          defaultWorkspace: workspaceDir,
          model: { provider, model },
          permissionMode: 'ask',
        })
      }
      if (url.pathname === '/config' && (req.method === 'PUT' || req.method === 'POST')) {
        await readBody(req).catch(() => ({}))
        return json(res, 200, {
          ok: true,
          applied: false,
          note: 'fixture ignores config pushes; route/workspace are fixed by run.sh',
        })
      }
      if (url.pathname === '/policies' && req.method === 'GET') {
        return json(res, 200, { rules: policies })
      }
      if (url.pathname === '/policies' && req.method === 'POST') {
        const body = await readBody(req)
        if (!body.toolName) return json(res, 400, { error: 'toolName required' })
        const ttlMs = Math.max(0, Number(body.ttlMs || 0))
        const rule = {
          id: randomUUID(),
          toolName: String(body.toolName),
          reason: String(body.reason || ''),
          pathPrefix: String(body.pathPrefix || ''),
          reasonPattern: String(body.reasonPattern || ''),
          createdAt: now(),
          expiresAt: ttlMs > 0 ? new Date(Date.now() + ttlMs).toISOString() : null,
        }
        policies.push(rule)
        auditEvent('policy.added', { policyId: rule.id, toolName: rule.toolName, pathPrefix: rule.pathPrefix, expiresAt: rule.expiresAt })
        return json(res, 200, { ok: true, rule })
      }
      if (url.pathname === '/policies' && req.method === 'DELETE') {
        const id = String(url.searchParams.get('id') || '')
        const before = policies.length
        for (let i = policies.length - 1; i >= 0; i -= 1) {
          if (policies[i].id === id) policies.splice(i, 1)
        }
        auditEvent('policy.removed', { policyId: id, removed: before - policies.length })
        return json(res, 200, { ok: true, removed: before - policies.length })
      }
      if (url.pathname === '/approval' && req.method === 'POST') {
        const body = await readBody(req)
        const requested = String(body.decision || '')
        if (!['allow', 'reject', 'always-allow'].includes(requested)) {
          return json(res, 400, { error: 'decision must be allow, reject or always-allow' })
        }
        const id = String(body.id || '')
        const pending = pendingApprovals.get(id)
        if (!pending) return json(res, 404, { error: 'approval not pending' })
        clearTimeout(pending.timer)
        pendingApprovals.delete(id)
        const outcome = requested === 'reject' ? 'rejected' : 'allowed-once'
        pending.resolve(outcome)
        push('approval.decided', { data: { id, outcome, toolName: pending.toolName } })
        auditEvent('approval.decided', { approvalId: id, outcome, toolName: pending.toolName, decision: requested })
        log('approval decision applied', { id, decision: requested, outcome })
        return json(res, 200, { ok: true, decision: requested, outcome })
      }
      if (url.pathname === '/cancel' && req.method === 'POST') {
        await readBody(req).catch(() => ({}))
        const result = await cancelTurn()
        auditEvent('session.cancelled', { sessionId: sessionId || null, cancelled: Boolean(result?.cancelled) })
        return json(res, 200, result)
      }

      // ---- W1 harness protocol (compatible with the same /turn) ----
      if (url.pathname === '/turn' && req.method === 'POST') {
        const body = await readBody(req)
        const result = await submitTurn(body.text, { clientTurnId: body.turnId || '' })
        return json(res, 200, { ok: true, accepted: true, ...result })
      }
      if (url.pathname === '/events' && req.method === 'GET') {
        if (!sseRequest) {
          const after = Number(url.searchParams.get('after') || 0)
          const limit = Math.min(Number(url.searchParams.get('limit') || 1000), 5000)
          const list = events.filter((event) => event.ioSeq > after).slice(0, limit)
          return json(res, 200, {
            events: list,
            next: list.length ? list[list.length - 1].ioSeq : after,
            total: events.length,
          })
        }
        res.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write(': connected\n\n')
        const subscriber = { res }
        sseSubscribers.add(subscriber)
        for (const frame of bridgeFrames) {
          try { res.write('data: ' + JSON.stringify(frame) + '\n\n') } catch { break }
        }
        req.on('close', () => sseSubscribers.delete(subscriber))
        return
      }
      return json(res, 404, { error: 'not_found' })
    } catch (error) {
      log('request failed: ' + messageOf(error))
      return json(res, 500, { error: messageOf(error) })
    }
  })

  server.listen(0, '127.0.0.1', () => {
    const address = server.address()
    writeFileSync(bridgeFile, JSON.stringify({
      fixture: FIXTURE,
      contractVersion: CONTRACT_VERSION,
      pluginVersion: VERSION,
      version: VERSION,
      pid: hostPid,
      port: address.port,
      token,
      startedAt,
      dshHome: String(process.env.DSH_HOME || ''),
      home: String(process.env.HOME || ''),
      profile: String(process.env.DSH_PROFILE || ''),
      workspaceDir,
    }, null, 2))
    try { chmodSync(bridgeFile, 0o600) } catch { /* ignore */ }
    log('bridge listening on 127.0.0.1:' + address.port, { bridgeFile, workspaceDir })
  })

  ctx.effect?.(() => () => {
    for (const subscriber of sseSubscribers) {
      try { subscriber.res.end() } catch { /* ignore */ }
    }
    sseSubscribers.clear()
    try { server.close() } catch { /* ignore */ }
    try { unlinkSync(bridgeFile) } catch { /* ignore */ }
    try { handle?.dispose?.() } catch { /* ignore */ }
    log('fixture disposed')
  })
}
