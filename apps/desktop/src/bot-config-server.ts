/** Local Bot settings/config service for the WhaleGirl Bot desktop shell. */
import { createServer, type Server } from 'node:http'
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export const BOT_CONFIG_PORT = 59100

export interface BotConfig {
  voice: { provider: string; baseUrl: string; apiKey: string; model: string; voice: string; wakeWord: string }
  agent: { mode: 'chat-only' | 'dsh'; workspace: string; session: string }
  persona: { name: string; personality: string; instructions: string }
  app: { autoStart: boolean; keepRunning: boolean }
}

export const DEFAULT_BOT_CONFIG: BotConfig = {
  voice: { provider: 'DashScope', baseUrl: 'wss://dashscope.aliyuncs.com/api-ws/v1/realtime', apiKey: '', model: 'Qwen Audio 3.0 Realtime Flash', voice: 'longanxiao', wakeWord: '' },
  agent: { mode: 'dsh', workspace: '', session: '' },
  persona: { name: 'WhaleGirl Bot', personality: '自然、可靠，有一点鲸鱼娘的温柔与俏皮，但不过度卖萌；有自己的判断，不刻意迎合；做事干脆。', instructions: '事实与执行结果必须来自 DSH。' },
  app: { autoStart: true, keepRunning: true },
}

const CONFIG_FILE = 'config.json'

function clampText(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value.slice(0, 8000) : fallback
}

function normalize(input: unknown): BotConfig {
  const raw = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>
  const section = (name: string): Record<string, unknown> => (raw[name] && typeof raw[name] === 'object' ? raw[name] as Record<string, unknown> : {})
  const voice = section('voice'); const agent = section('agent'); const persona = section('persona'); const appSection = section('app')
  return {
    voice: {
      provider: clampText(voice.provider, DEFAULT_BOT_CONFIG.voice.provider),
      baseUrl: clampText(voice.baseUrl, DEFAULT_BOT_CONFIG.voice.baseUrl),
      apiKey: clampText(voice.apiKey),
      model: clampText(voice.model, DEFAULT_BOT_CONFIG.voice.model),
      voice: clampText(voice.voice, DEFAULT_BOT_CONFIG.voice.voice),
      wakeWord: clampText(voice.wakeWord),
    },
    agent: {
      mode: agent.mode === 'chat-only' ? 'chat-only' : 'dsh',
      workspace: clampText(agent.workspace),
      session: clampText(agent.session),
    },
    persona: {
      name: clampText(persona.name, DEFAULT_BOT_CONFIG.persona.name),
      personality: clampText(persona.personality, DEFAULT_BOT_CONFIG.persona.personality),
      instructions: clampText(persona.instructions, DEFAULT_BOT_CONFIG.persona.instructions),
    },
    app: {
      autoStart: appSection.autoStart !== false,
      keepRunning: appSection.keepRunning !== false,
    },
  }
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

function page(): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Bot</title>
<style>
:root{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;color:#18181b;background:#fff}
body{margin:0;padding:24px 28px;font-size:13px}h1{font-size:18px;margin:0 0 2px}.sub{color:#71717a;margin-bottom:18px}
.tabs{display:flex;gap:6px;border-bottom:1px solid #e4e4e7;margin-bottom:18px}.tab{padding:7px 12px;border-radius:8px 8px 0 0;cursor:pointer;color:#52525b}.tab.active{background:#f4f4f5;color:#09090b;font-weight:600}
.panel{display:none}.panel.active{display:block}.row{display:flex;align-items:flex-start;gap:16px;padding:10px 0;border-bottom:1px solid #f4f4f5}.label{width:120px;color:#3f3f46;flex:none}.field{flex:1;max-width:520px}input,select,textarea{width:100%;box-sizing:border-box;padding:7px 9px;border:1px solid #d4d4d8;border-radius:7px;font:inherit;background:#fff}textarea{min-height:84px;resize:vertical}.hint{color:#a1a1aa;font-size:12px;margin-top:4px}
.actions{margin-top:18px;display:flex;gap:10px;align-items:center}button{padding:7px 16px;border-radius:8px;border:1px solid #18181b;background:#18181b;color:#fff;cursor:pointer}.status{color:#71717a}
</style></head><body>
<h1>Bot</h1><div class="sub">管理语音前台、后台 Agent、Bot 人格与应用程序</div>
<div class="tabs" id="tabs"></div>
<div id="panels"></div>
<div class="actions"><button id="save">保存</button><button id="restart" style="background:#fff;color:#18181b">重启语音</button><span class="status" id="status"></span></div><div class="hint" id="runtime" style="margin-top:10px"></div>
<script>
const schema=[
  {id:'voice',label:'语音前台',fields:[['provider','供应商','text'],['baseUrl','服务地址','text'],['apiKey','API Key','password'],['model','模型','text'],['voice','音色','text'],['wakeWord','唤醒词','text']]},
  {id:'agent',label:'后台 Agent',fields:[['mode','模式','select'],['workspace','默认工作区','text'],['session','默认会话','text']]},
  {id:'persona',label:'Bot 人格',fields:[['name','称呼','text'],['personality','性格','textarea'],['instructions','人格说明','textarea']]},
  {id:'app',label:'应用程序',fields:[['autoStart','开机启动','checkbox'],['keepRunning','窗口关闭后保持运行','checkbox']]},
];
let config=null;let active='voice';
const tabs=document.getElementById('tabs'),panels=document.getElementById('panels'),status=document.getElementById('status');
function render(){
  tabs.innerHTML='';panels.innerHTML='';
  for(const s of schema){
    const t=document.createElement('div');t.className='tab'+(active===s.id?' active':'');t.textContent=s.label;t.onclick=()=>{active=s.id;render()};tabs.appendChild(t);
    const p=document.createElement('div');p.className='panel'+(active===s.id?' active':'');
    for(const [key,label,type] of s.fields){
      const row=document.createElement('div');row.className='row';
      const lab=document.createElement('div');lab.className='label';lab.textContent=label;
      const f=document.createElement('div');f.className='field';
      let el;
      if(type==='textarea'){el=document.createElement('textarea');el.value=config[s.id][key]||''}
      else if(type==='select'){el=document.createElement('select');for(const v of ['dsh','chat-only']){const o=document.createElement('option');o.value=v;o.textContent=v;el.appendChild(o)}el.value=config[s.id][key]||'dsh'}
      else if(type==='checkbox'){el=document.createElement('input');el.type='checkbox';el.checked=config[s.id][key]!==false}
      else{el=document.createElement('input');el.type=type;el.value=config[s.id][key]||''}
      el.dataset.section=s.id;el.dataset.key=key;
      el.oninput=el.onchange=()=>{config[s.id][key]=type==='checkbox'?el.checked:el.value;status.textContent='未保存'};
      f.appendChild(el);row.append(lab,f);p.appendChild(row);
    }
    panels.appendChild(p);
  }
}
async function load(){const r=await fetch('/bot/config');config=(await r.json()).config;render()}
document.getElementById('save').onclick=async()=>{const r=await fetch('/bot/config',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(config)});const j=await r.json();status.textContent=r.ok?'已保存':'保存失败';if(r.ok)config=j.config};
document.getElementById('restart').onclick=async()=>{status.textContent='重启中…';const r=await fetch('/bot/restart',{method:'POST'});const j=await r.json();status.textContent=r.ok?'已重启':'重启失败';document.getElementById('runtime').textContent=JSON.stringify(j.status)};
async function poll(){try{const s=await (await fetch('/bot/status')).json();document.getElementById('runtime').textContent=s.status?('语音网关：'+(s.status.gateway?'运行中 pid '+s.status.pid:'未运行')+' · '+s.status.voiceDir):'语音网关：未配置'}catch{}}
poll();setInterval(poll,3000);
load();
</script></body></html>`
}

export interface BotConfigHooks {
  status?: () => unknown
  onConfigSaved?: (config: BotConfig) => void | Promise<void>
  onRestart?: () => unknown | Promise<unknown>
  onToggleMain?: () => unknown | Promise<unknown>
  onOpenSettings?: () => unknown | Promise<unknown>
  onApproval?: (id: string, decision: string) => unknown | Promise<unknown>
}

export async function startBotConfigServer(
  dshHome: string,
  port = BOT_CONFIG_PORT,
  hooks: BotConfigHooks = {},
): Promise<{ close: () => Promise<void>; port: number }> {
  const configDir = join(dshHome, 'bot')
  const server: Server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://127.0.0.1')
      if (url.pathname === '/bot/settings') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(page()); return
      }
      if (url.pathname === '/bot/status' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, status: hooks.status?.() ?? null })); return
      }
      if (url.pathname === '/bot/restart' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, status: await hooks.onRestart?.() ?? null })); return
      }
      if (url.pathname === '/bot/open-settings' && req.method === 'POST') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result: await hooks.onOpenSettings?.() ?? null })); return
      }
      if (url.pathname === '/bot/approval' && req.method === 'POST') {
        const body = JSON.parse(await new Promise<string>((resolve) => { const chunks: Buffer[] = []; req.on('data', c => chunks.push(Buffer.from(c))); req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8') || '{}')) }))
        const result = await hooks.onApproval?.(String(body.id || ''), String(body.decision || '')) ?? null
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); return
      }
      if (url.pathname === '/bot/toggle-main' && req.method === 'POST') {
        const result = await hooks.onToggleMain?.() ?? null
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, result })); return
      }
      if (url.pathname === '/bot/config' && req.method === 'GET') {
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, config: await readConfig(configDir) })); return
      }
      if (url.pathname === '/bot/config' && (req.method === 'PUT' || req.method === 'POST')) {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
        const config = await writeConfig(configDir, JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'))
        await hooks.onConfigSaved?.(config)
        res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true, config })); return
      }
      res.writeHead(404, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: 'not found' }))
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: false, error: String((error as Error)?.message || error) }))
    }
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => resolve())
  })
  return { port, close: () => new Promise<void>(resolve => server.close(() => resolve())) }
}
