/** Local Bot settings/config service for the WhaleGirlBot desktop shell. */
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LLM_PROVIDERS,
  VOICE_PROVIDERS,
  normalizeVoiceProviderId,
  testLlmProvider,
  testVoiceProvider,
  type ProviderTestDeps,
  type ProviderTestResult,
} from './bot-providers.ts'

export const BOT_CONFIG_PORT = 59100

export interface BotConfig {
  voice: { provider: string; baseUrl: string; apiKey: string; model: string; voice: string; wakeWord: string }
  llm: { provider: string; model: string; baseUrl: string; apiKey: string }
  agent: { mode: 'chat-only' | 'dsh'; workspace: string; session: string }
  persona: { name: string; personality: string; tone: string; instructions: string }
  app: { autoStart: boolean; keepRunning: boolean }
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
  persona: { name: 'Nisse（家灵）', personality: '自然、可靠，有一点鲸鱼娘的温柔与俏皮，但不过度卖萌；有自己的判断，不刻意迎合；做事干脆。', tone: '简短、清楚、不啰嗦；必要时先给结论。', instructions: '事实与执行结果必须来自 DSH；不编造执行结果。' },
  app: { autoStart: true, keepRunning: true },
}

const CONFIG_FILE = 'config.json'

function clampText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 8000) : fallback
}

function sectionOf(raw: Record<string, unknown>, name: string): Record<string, unknown> {
  return raw[name] && typeof raw[name] === 'object' ? raw[name] as Record<string, unknown> : {}
}

/** Normalize any stored/partial config into the current schema (older files keep every existing field). */
function normalize(input: unknown): BotConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const voice = sectionOf(raw, 'voice'); const llm = sectionOf(raw, 'llm')
  const agent = sectionOf(raw, 'agent'); const persona = sectionOf(raw, 'persona'); const appSection = sectionOf(raw, 'app')
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
      instructions: clampText(persona.instructions, DEFAULT_BOT_CONFIG.persona.instructions),
    },
    app: {
      autoStart: appSection.autoStart !== false,
      keepRunning: appSection.keepRunning !== false,
    },
  }
}

/** Strip secrets for the browser while preserving "a key is stored" semantics. */
function toView(config: BotConfig): BotConfigView {
  const { apiKey: voiceKey, ...voice } = config.voice
  const { apiKey: llmKey, ...llm } = config.llm
  return {
    ...config,
    voice: { ...voice, apiKeySet: voiceKey !== '' },
    llm: { ...llm, apiKeySet: llmKey !== '' },
  }
}

/** Merge an edit over the stored config: an empty submitted secret keeps the stored one. */
function mergeEdit(stored: BotConfig, edit: unknown): BotConfig {
  const raw = (edit && typeof edit === 'object' ? edit : {}) as Record<string, unknown>
  const voice = sectionOf(raw, 'voice'); const llm = sectionOf(raw, 'llm')
  const submittedVoiceKey = typeof voice.apiKey === 'string' ? voice.apiKey.trim() : ''
  const submittedLlmKey = typeof llm.apiKey === 'string' ? llm.apiKey.trim() : ''
  return normalize({
    ...stored,
    ...raw,
    voice: { ...stored.voice, ...voice, apiKey: submittedVoiceKey === '' ? stored.voice.apiKey : submittedVoiceKey },
    llm: { ...stored.llm, ...llm, apiKey: submittedLlmKey === '' ? stored.llm.apiKey : submittedLlmKey },
  })
}

async function readConfig(configDir: string): Promise<BotConfig> {
  try {
    return normalize(JSON.parse(await readFile(join(configDir, CONFIG_FILE), 'utf8')))
  } catch {
    return structuredClone(DEFAULT_BOT_CONFIG)
  }
}

async function writeConfig(configDir: string, value: unknown): Promise<BotConfig> {
  const config = normalize(value)
  await mkdir(configDir, { recursive: true, mode: 0o700 })
  const file = join(configDir, CONFIG_FILE)
  await writeFile(file, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 })
  await chmod(file, 0o600).catch(() => undefined)
  return config
}

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
  const catalog = providerCatalogJson()
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Bot</title>
<style>
:root{
  color-scheme:light dark;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --line-soft:#f4f4f5;
  --field-bg:#ffffff; --field-border:#d4d4d8;
  --tab:#52525b; --tab-active-bg:rgba(0,0,0,.06); --tab-active-fg:#09090b;
  --btn-bg:#18181b; --btn-fg:#ffffff; --btn-border:#18181b; --btn-plain-fg:#18181b;
  --hint:#a1a1aa; --ok:#15803d; --fail:#b91c1c;
}
@media (prefers-color-scheme: dark){
  :root{
    --fg:#e4e4e7; --muted:#a1a1aa; --line:#3f3f46; --line-soft:rgba(255,255,255,.06);
    --field-bg:rgba(255,255,255,.05); --field-border:#52525b;
    --tab:#a1a1aa; --tab-active-bg:rgba(255,255,255,.10); --tab-active-fg:#fafafa;
    --btn-bg:#fafafa; --btn-fg:#18181b; --btn-border:#fafafa; --btn-plain-fg:#e4e4e7;
    --hint:#71717a; --ok:#4ade80; --fail:#f87171;
  }
}
html,body{background:transparent;color:var(--fg)}
body{margin:0;padding:24px 28px;font-size:13px}
h1{font-size:18px;margin:0 0 2px}.sub{color:var(--muted);margin-bottom:18px}
.tabs{display:flex;gap:6px;border-bottom:1px solid var(--line);margin-bottom:18px;flex-wrap:wrap}
.tab{padding:7px 12px;border-radius:8px 8px 0 0;cursor:pointer;color:var(--tab)}
.tab.active{background:var(--tab-active-bg);color:var(--tab-active-fg);font-weight:600}
.panel{display:none}.panel.active{display:block}
.row{display:flex;align-items:flex-start;gap:16px;padding:10px 0;border-bottom:1px solid var(--line-soft)}
.label{width:130px;color:var(--muted);flex:none;padding-top:7px}
.field{flex:1;max-width:540px}
input,select,textarea{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid var(--field-border);border-radius:7px;font:inherit;background:var(--field-bg);color:var(--fg)}
input::placeholder,textarea::placeholder{color:var(--hint)}
textarea{min-height:84px;resize:vertical}
.hint{color:var(--hint);font-size:12px;margin-top:4px}
.actions{margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{padding:7px 16px;border-radius:8px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-fg);cursor:pointer}
button.plain,button.test{background:transparent;color:var(--btn-plain-fg);border-color:var(--field-border)}
.status{color:var(--muted)}
.test-row{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.test-result{font-size:12px;color:var(--muted)}
.test-result.ok{color:var(--ok)}.test-result.fail{color:var(--fail)}
.with-button{display:flex;gap:8px}.with-button input{flex:1}.with-button button{flex:none}
</style></head><body>
<h1>Bot</h1><div class="sub">管理语音前台、LLM 模型、后台 Agent、Bot 人格与应用程序</div>
<div class="tabs" id="tabs"></div>
<div id="panels"></div>
<div class="actions"><button id="save">保存</button><button id="restart" class="plain">重启语音</button><span class="status" id="status"></span></div><div class="hint" id="runtime" style="margin-top:10px"></div>
<script>
var CATALOG = ${catalog};
var schema = [
  {id:'voice', label:'语音前台', fields:[
    {key:'provider', label:'供应商', type:'select', options:CATALOG.voice.map(function(p){return [p.id,p.label]})},
    {key:'baseUrl', label:'服务地址', type:'text'},
    {key:'model', label:'模型', type:'text'},
    {key:'voice', label:'音色', type:'text'},
    {key:'apiKey', label:'API Key', type:'password'},
    {key:'wakeWord', label:'唤醒词', type:'text'}
  ], test:'voice'},
  {id:'llm', label:'LLM 模型', fields:[
    {key:'provider', label:'供应商', type:'select', options:CATALOG.llm.map(function(p){return [p.id,p.label]})},
    {key:'model', label:'模型', type:'text'},
    {key:'baseUrl', label:'服务地址', type:'text'},
    {key:'apiKey', label:'API Key', type:'password'}
  ], test:'llm'},
  {id:'agent', label:'后台 Agent', fields:[
    {key:'mode', label:'模式', type:'select', options:[['dsh','DSH（唯一 Agent）'],['chat-only','仅语音聊天']]},
    {key:'workspace', label:'默认工作区', type:'workspace'},
    {key:'session', label:'默认会话', type:'text'}
  ]},
  {id:'persona', label:'Bot 人格', fields:[
    {key:'name', label:'称呼', type:'text'},
    {key:'personality', label:'性格', type:'textarea'},
    {key:'tone', label:'语气', type:'textarea'},
    {key:'instructions', label:'人格说明', type:'textarea'}
  ]},
  {id:'app', label:'应用程序', fields:[
    {key:'autoStart', label:'开机启动', type:'checkbox'},
    {key:'keepRunning', label:'窗口关闭后保持运行', type:'checkbox'}
  ]}
];
var config=null; var active='voice';
var tabs=document.getElementById('tabs'), panels=document.getElementById('panels'), status=document.getElementById('status');
function el(tag, cls, text){ var e=document.createElement(tag); if(cls) e.className=cls; if(text!==undefined) e.textContent=text; return e; }
function render(){
  tabs.innerHTML=''; panels.innerHTML='';
  for (var s=0;s<schema.length;s++){
    (function(spec){
      var t=el('div','tab'+(active===spec.id?' active':''),spec.label);
      t.onclick=function(){ active=spec.id; render(); };
      tabs.appendChild(t);
      var p=el('div','panel'+(active===spec.id?' active':''));
      for (var f=0;f<spec.fields.length;f++){
        var field=spec.fields[f];
        var row=el('div','row'); row.appendChild(el('div','label',field.label));
        var wrap=el('div','field'); var input;
        if (field.type==='textarea'){ input=document.createElement('textarea'); input.value=config[spec.id][field.key]||''; }
        else if (field.type==='select'){
          input=document.createElement('select');
          for (var o=0;o<field.options.length;o++){ var opt=document.createElement('option'); opt.value=field.options[o][0]; opt.textContent=field.options[o][1]; input.appendChild(opt); }
          input.value=config[spec.id][field.key]||field.options[0][0];
        }
        else if (field.type==='checkbox'){ input=document.createElement('input'); input.type='checkbox'; input.checked=config[spec.id][field.key]!==false; }
        else { input=document.createElement('input'); input.type=field.type==='password'?'password':'text'; input.value=config[spec.id][field.key]||''; if(field.type==='password'){ input.placeholder='留空保持不变'; } }
        input.dataset.section=spec.id; input.dataset.key=field.key;
        input.oninput=input.onchange=function(ev){
          var target=ev.target; config[target.dataset.section][target.dataset.key]=target.type==='checkbox'?target.checked:target.value;
          status.textContent='未保存';
        };
        if (field.type==='workspace'){
          var withButton=el('div','with-button');
          input.placeholder='留空使用默认（DSH_HOME/workspace）';
          withButton.appendChild(input);
          var pick=el('button','plain','选择…');
          pick.onclick=async function(){
            var r=await fetch('/bot/workspace/pick',{method:'POST'});
            var j=await r.json().catch(function(){return null});
            if (j&&j.ok&&j.path){ config.agent.workspace=j.path; input.value=j.path; status.textContent='未保存'; }
            else { status.textContent=(j&&j.error)||'选择目录失败'; }
          };
          withButton.appendChild(pick);
          wrap.appendChild(withButton);
        } else { wrap.appendChild(input); }
        if (field.type==='password' && config[spec.id][field.key+'Set']) wrap.appendChild(el('div','hint','已保存密钥；留空保持不变'));
        row.appendChild(wrap); p.appendChild(row);
      }
      if (spec.test){
        var testRow=el('div','test-row'); var testBtn=el('button','test','测试连接'); var testResult=el('span','test-result','');
        testBtn.onclick=async function(){
          testBtn.disabled=true; testResult.className='test-result'; testResult.textContent='测试中…';
          try {
            var reqBody={}; reqBody[spec.test]=config[spec.test];
            var r=await fetch('/bot/test/'+spec.test,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(reqBody)});
            var j=await r.json(); var payload=j.result||{};
            if (payload.ok){ testResult.className='test-result ok'; testResult.textContent='✓ '+payload.detail+' · '+payload.latencyMs+'ms'; }
            else { testResult.className='test-result fail'; testResult.textContent='✗ '+(payload.hint||payload.error||'测试失败')+(payload.detail?'（'+payload.detail+'）':''); }
          } catch (e) { testResult.className='test-result fail'; testResult.textContent='✗ 测试请求失败：'+String(e&&e.message||e); }
          testBtn.disabled=false;
        };
        testRow.appendChild(testBtn); testRow.appendChild(testResult); p.appendChild(testRow);
      }
      panels.appendChild(p);
    })(schema[s]);
  }
}
async function load(){ var r=await fetch('/bot/config'); var j=await r.json(); config=j.config; render(); }
document.getElementById('save').onclick=async function(){
  status.textContent='保存中…';
  var r=await fetch('/bot/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(config)});
  var j=await r.json(); status.textContent=r.ok?'已保存':('保存失败：'+((j&&j.error)||r.status));
  if(r.ok){ config=j.config; render(); }
};
document.getElementById('restart').onclick=async function(){
  status.textContent='重启中…';
  var r=await fetch('/bot/restart',{method:'POST'}); var j=await r.json();
  status.textContent=r.ok?'已重启':'重启失败';
  document.getElementById('runtime').textContent=JSON.stringify(j.status);
};
async function poll(){
  try{ var s=await (await fetch('/bot/status')).json(); var st=s.status;
    document.getElementById('runtime').textContent=st?('语音网关：'+(st.gateway?'运行中 pid '+st.pid:'未运行')+' · '+(st.error||st.voiceDir)):'语音网关：未配置';
  }catch(e){}
}
poll(); setInterval(poll,3000); load();
</script></body></html>`
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

export async function startBotConfigServer(
  dshHome: string,
  port = BOT_CONFIG_PORT,
  hooks: BotConfigHooks = {},
  options: BotConfigServerOptions = {},
): Promise<{ close: () => Promise<void>; port: number }> {
  const configDir = join(dshHome, 'bot')
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
      if (url.pathname === '/bot/settings') {
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
          reply(200, { ok: false, error: String((error as Error)?.message || error) })
        }
        return
      }
      if (url.pathname === '/bot/config' && req.method === 'GET') { reply(200, { ok: true, config: toView(await readConfig(configDir)) }); return }
      if (url.pathname === '/bot/config' && (req.method === 'PUT' || req.method === 'POST')) {
        const stored = await readConfig(configDir)
        const merged = mergeEdit(stored, await readBody(req))
        const config = await writeConfig(configDir, merged)
        await hooks.onConfigSaved?.(config)
        reply(200, { ok: true, config: toView(config) })
        return
      }
      if (url.pathname === '/bot/test/llm' && req.method === 'POST') {
        const stored = await readConfig(configDir)
        const body = await readBody(req).catch(() => ({})) as { llm?: Partial<BotConfig['llm']> }
        const merged = mergeEdit(stored, { llm: { ...stored.llm, ...(body.llm || {}) } })
        const result: ProviderTestResult = await testLlmProvider(merged.llm, testDeps)
        reply(200, { ok: true, result })
        return
      }
      if (url.pathname === '/bot/test/voice' && req.method === 'POST') {
        const stored = await readConfig(configDir)
        const body = await readBody(req).catch(() => ({})) as { voice?: Partial<BotConfig['voice']> }
        const merged = mergeEdit(stored, { voice: { ...stored.voice, ...(body.voice || {}) } })
        const result: ProviderTestResult = await testVoiceProvider(merged.voice, testDeps)
        reply(200, { ok: true, result })
        return
      }
      reply(404, { ok: false, error: 'not found' })
    } catch (error) {
      reply(500, { ok: false, error: String((error as Error)?.message || error) })
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
