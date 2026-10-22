/**
 * Bot settings page: a single self-contained HTML document served at `/bot/settings`
 * and embedded by DSH Settings -> Bot through an iframe (same product, no extra window).
 *
 * The page is deliberately plain vanilla JS (no bundler, no framework, no account UI) and
 * follows the system light/dark theme through `prefers-color-scheme`. It talks only to the
 * local loopback Bot config service:
 *  - GET/PUT `/bot/config`                          (all sections, secrets never echoed)
 *  - POST `/bot/test/llm`, `/bot/test/voice`        (existing connection probes)
 *  - GET  `/bot/prompt/preview`                     (assembled persona prompt + voice prefix)
 *  - POST `/bot/memory/list|correct|delete|history` (memory administration)
 *  - POST `/bot/memory/search|export|forget`        (existing memory actions)
 *  - GET  `/bot/status`, POST `/bot/restart`        (existing voice gateway runtime)
 *
 * `catalogJson` is the provider catalog serialized by bot-config-server (never secrets).
 * The generated `<script>` body is validated with `new Function` by the node test suite, so
 * it must stay syntactically self-contained (no template literals / no backslash escapes).
 */
export function buildBotSettingsPage(catalogJson: string): string {
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>Bot</title>
<style>
:root{
  color-scheme:light dark;
  font-family:-apple-system,BlinkMacSystemFont,"PingFang SC",sans-serif;
  --fg:#18181b; --muted:#71717a; --line:#e4e4e7; --line-soft:#f4f4f5;
  --field-bg:#ffffff; --field-border:#d4d4d8;
  --tab:#52525b; --tab-active-bg:rgba(0,0,0,.06); --tab-active-fg:#09090b;
  --btn-bg:#18181b; --btn-fg:#ffffff; --btn-border:#18181b; --btn-plain-fg:#18181b;
  --hint:#a1a1aa; --ok:#15803d; --fail:#b91c1c; --warn:#b45309;
  --pre-bg:rgba(0,0,0,.04); --pre-border:#e4e4e7;
}
@media (prefers-color-scheme: dark){
  :root{
    --fg:#e4e4e7; --muted:#a1a1aa; --line:#3f3f46; --line-soft:rgba(255,255,255,.06);
    --field-bg:rgba(255,255,255,.05); --field-border:#52525b;
    --tab:#a1a1aa; --tab-active-bg:rgba(255,255,255,.10); --tab-active-fg:#fafafa;
    --btn-bg:#fafafa; --btn-fg:#18181b; --btn-border:#fafafa; --btn-plain-fg:#e4e4e7;
    --hint:#71717a; --ok:#4ade80; --fail:#f87171; --warn:#fbbf24;
    --pre-bg:rgba(255,255,255,.06); --pre-border:#3f3f46;
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
input[type=checkbox],input[type=radio]{width:auto}
input::placeholder,textarea::placeholder{color:var(--hint)}
textarea{min-height:84px;resize:vertical}
.hint{color:var(--hint);font-size:12px;margin-top:4px;line-height:1.45}
.actions{margin-top:18px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
button{padding:7px 16px;border-radius:8px;border:1px solid var(--btn-border);background:var(--btn-bg);color:var(--btn-fg);cursor:pointer;font:inherit}
button:disabled{opacity:.45;cursor:default}
button.plain,button.test{background:transparent;color:var(--btn-plain-fg);border-color:var(--field-border)}
.status{color:var(--muted)}
.test-row{display:flex;gap:10px;align-items:center;margin-top:8px;flex-wrap:wrap}
.test-result{font-size:12px;color:var(--muted)}
.test-result.ok{color:var(--ok)}.test-result.fail{color:var(--fail)}
.with-button{display:flex;gap:8px}.with-button input{flex:1}.with-button button{flex:none}
.panel-title{font-weight:600;margin:16px 0 6px}
.divider{border-top:1px solid var(--line);margin:20px 0 8px}
.preview-block{margin:8px 0 14px}
.preview-title{font-weight:600;margin-bottom:4px}
pre.preview{margin:0;padding:10px 12px;max-height:260px;overflow:auto;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,Menlo,monospace;font-size:12px;line-height:1.5;background:var(--pre-bg);border:1px solid var(--pre-border);border-radius:8px}
.prompt-override{min-height:150px;font-family:ui-monospace,Menlo,monospace;font-size:12px}
.radio-row{display:flex;gap:10px;align-items:flex-start;padding:9px 0;border-bottom:1px solid var(--line-soft);cursor:pointer}
.radio-row input{margin-top:4px;flex:none}
.radio-body{flex:1}
.radio-label{font-weight:600}
.mem-toolbar{display:flex;gap:8px;flex-wrap:wrap;margin:8px 0;align-items:center}
.mem-toolbar input{flex:1;min-width:180px;width:auto}
.mem-toolbar button{padding:6px 12px}
.mem-message{font-size:12px;color:var(--warn);margin:6px 0;white-space:pre-wrap}
.mem-list{max-height:430px;overflow:auto;border:1px solid var(--line);border-radius:8px;padding:2px 12px;margin-top:4px}
.mem-item{padding:9px 0;border-bottom:1px solid var(--line-soft)}
.mem-item:last-child{border-bottom:none}
.mem-head{display:flex;gap:10px;align-items:center;color:var(--muted);font-size:12px;flex-wrap:wrap}
.mem-kind{background:var(--tab-active-bg);border-radius:4px;padding:1px 6px;color:var(--tab-active-fg);font-weight:600}
.mem-id{font-family:ui-monospace,Menlo,monospace}
.mem-text{white-space:pre-wrap;word-break:break-word;margin:5px 0;line-height:1.55}
.mem-actions{display:flex;gap:8px;flex-wrap:wrap}
.mem-actions button{padding:3px 10px;font-size:12px;border-radius:6px}
.mem-history{margin:8px 0 4px;padding:8px 12px;border-left:3px solid var(--field-border);background:var(--pre-bg);border-radius:0 6px 6px 0;font-size:12px}
.hist-title{font-weight:600;margin-bottom:4px}
.hist-row{margin:6px 0}
.hist-meta{color:var(--muted)}
.hist-old{color:var(--muted);white-space:pre-wrap;word-break:break-word}
.hist-new{white-space:pre-wrap;word-break:break-word}
.mem-pager{display:flex;gap:10px;align-items:center;margin-top:10px;flex-wrap:wrap}
</style></head><body>
<h1>Bot</h1><div class="sub">管理语音前台、LLM 模型、后台 Agent、Bot 人格、提示词、权限与记忆</div>
<div class="tabs" id="tabs"></div>
<div id="panels"></div>
<div class="actions"><button id="save">保存</button><button id="restart" class="plain">重启语音</button><span class="status" id="status"></span></div><div class="hint" id="runtime" style="margin-top:10px"></div>
<script>
var CATALOG = ${catalogJson};
var SCHEMA = [
  {id:'voice', label:'语音前台', kind:'fields', test:'voice', fields:[
    {key:'provider', label:'供应商', type:'select', options:CATALOG.voice.map(function(p){return [p.id,p.label]})},
    {key:'baseUrl', label:'服务地址', type:'text'},
    {key:'model', label:'模型', type:'text'},
    {key:'voice', label:'音色', type:'text'},
    {key:'apiKey', label:'API Key', type:'password'},
    {key:'wakeWord', label:'唤醒词', type:'text'}
  ]},
  {id:'llm', label:'LLM 模型', kind:'fields', test:'llm', fields:[
    {key:'provider', label:'供应商', type:'select', options:CATALOG.llm.map(function(p){return [p.id,p.label]})},
    {key:'model', label:'模型', type:'text'},
    {key:'baseUrl', label:'服务地址', type:'text'},
    {key:'apiKey', label:'API Key', type:'password'}
  ]},
  {id:'agent', label:'后台 Agent', kind:'fields', fields:[
    {key:'mode', label:'模式', type:'select', options:[['dsh','DSH（唯一 Agent）'],['chat-only','仅语音聊天']]},
    {key:'workspace', label:'默认工作区', type:'workspace'},
    {key:'session', label:'默认会话', type:'text'}
  ]},
  {id:'persona', label:'Bot 人格', kind:'fields', fields:[
    {key:'name', label:'称呼', type:'text'},
    {key:'personality', label:'性格', type:'textarea'},
    {key:'tone', label:'语气', type:'textarea'},
    {key:'background', label:'身份/背景', type:'textarea'},
    {key:'quirks', label:'说话风格/口癖', type:'text'},
    {key:'addressUser', label:'对用户的称呼', type:'text'},
    {key:'boundaries', label:'边界/禁忌', type:'textarea'},
    {key:'instructions', label:'人格说明', type:'textarea'}
  ]},
  {id:'prompt', label:'提示词', kind:'prompt'},
  {id:'permissions', label:'权限', kind:'permissions'},
  {id:'app', label:'应用程序', kind:'fields', fields:[
    {key:'autoStart', label:'开机启动', type:'checkbox'},
    {key:'keepRunning', label:'窗口关闭后保持运行', type:'checkbox'}
  ]},
  {id:'memory', label:'记忆', kind:'memory'}
];
var config = null;
var active = 'voice';
var statusNode = null, tabsNode = null, panelsNode = null;
var promptPreview = null, promptLoading = false, promptLoaded = false, promptError = '';
var mem = {list:[], offset:0, limit:50, hasMore:false, available:null, note:'', message:'', loading:false, loaded:false, mode:'list', query:'', editingId:'', editText:'', historyId:'', history:[], historyNote:'', autoStarted:false};
function el(tag, cls, text){ var e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; }
function button(label, cls, onclick){ var b = el('button', cls || 'plain', label); b.onclick = onclick; return b; }
function hint(text){ return el('div', 'hint', text); }
function markDirty(){ if (statusNode) statusNode.textContent = '未保存'; }
function formatDate(value){ if (!value) return ''; var s = String(value); return s.length > 19 ? s.slice(0, 19).replace('T', ' ') : s; }
function sectionOf(id){ return config && config[id] ? config[id] : {}; }
function api(path, options){
  return fetch(path, options || {}).then(function(r){
    return r.json().then(function(j){ return {status:r.status, json:j}; }).catch(function(){ return {status:r.status, json:null}; });
  }).catch(function(e){ return {status:0, json:null, error:String((e && e.message) || e)}; });
}
function postJson(path, body){ return api(path, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(body || {})}); }
function putJson(path, body){ return api(path, {method:'PUT', headers:{'content-type':'application/json'}, body:JSON.stringify(body || {})}); }
function errorText(payload, fallback){
  if (payload && payload.error){
    if (typeof payload.error === 'string' && payload.error !== '') return payload.error;
    if (payload.error.message) return payload.error.message;
    if (payload.error.code) return payload.error.code;
  }
  if (payload && payload.note) return payload.note;
  if (payload && payload.message) return payload.message;
  if (payload && payload.error && typeof payload.error === 'string') return payload.error;
  return fallback || '请求失败';
}
function render(){
  if (window.__memoryTimer){ clearInterval(window.__memoryTimer); window.__memoryTimer = null; }
  tabsNode.innerHTML = ''; panelsNode.innerHTML = '';
  var current = null;
  for (var i = 0; i < SCHEMA.length; i++){
    (function(spec){
      var t = el('div', 'tab' + (active === spec.id ? ' active' : ''), spec.label);
      t.onclick = function(){ switchTab(spec.id); };
      tabsNode.appendChild(t);
      if (active === spec.id) current = spec;
    })(SCHEMA[i]);
  }
  if (!current) current = SCHEMA[0];
  panelsNode.appendChild(buildPanel(current));
}
function switchTab(id){
  active = id;
  if (id === 'prompt' && promptPreview === null && !promptLoading) loadPromptPreview();
  render();
}
function buildPanel(spec){
  var p = el('div', 'panel active');
  if (spec.kind === 'fields') renderFieldsPanel(p, spec);
  else if (spec.kind === 'prompt') renderPromptPanel(p);
  else if (spec.kind === 'permissions') renderPermissionsPanel(p);
  else if (spec.kind === 'memory') renderMemoryPanel(p);
  return p;
}
function renderFieldsPanel(panel, spec){
  var section = sectionOf(spec.id);
  for (var f = 0; f < spec.fields.length; f++){
    var field = spec.fields[f];
    var row = el('div', 'row');
    row.appendChild(el('div', 'label', field.label));
    var wrap = el('div', 'field');
    var input = null;
    if (field.type === 'textarea'){ input = document.createElement('textarea'); input.value = section[field.key] || ''; }
    else if (field.type === 'select'){
      input = document.createElement('select');
      for (var o = 0; o < field.options.length; o++){ var opt = document.createElement('option'); opt.value = field.options[o][0]; opt.textContent = field.options[o][1]; input.appendChild(opt); }
      input.value = section[field.key] || field.options[0][0];
    }
    else if (field.type === 'checkbox'){ input = document.createElement('input'); input.type = 'checkbox'; input.checked = section[field.key] !== false; }
    else { input = document.createElement('input'); input.type = field.type === 'password' ? 'password' : 'text'; input.value = section[field.key] || ''; if (field.type === 'password') input.placeholder = '留空保持不变'; }
    input.dataset.key = field.key;
    input.oninput = input.onchange = function(ev){
      var target = ev.target;
      if (!config[spec.id]) config[spec.id] = {};
      config[spec.id][target.dataset.key] = target.type === 'checkbox' ? target.checked : target.value;
      markDirty();
    };
    if (field.type === 'workspace'){
      var withButton = el('div', 'with-button');
      input.placeholder = '留空使用默认（DSH_HOME/workspace）';
      withButton.appendChild(input);
      withButton.appendChild(button('选择…', 'plain', async function(){
        var r = await postJson('/bot/workspace/pick');
        if (r.json && r.json.ok && r.json.path){ config.agent.workspace = r.json.path; input.value = r.json.path; markDirty(); }
        else if (statusNode) statusNode.textContent = (r.json && (r.json.error || (r.json.error && r.json.error.message))) || '选择目录失败';
      }));
      wrap.appendChild(withButton);
    } else {
      wrap.appendChild(input);
    }
    if (field.type === 'password' && section[field.key + 'Set']) wrap.appendChild(hint('已保存密钥；留空保持不变'));
    row.appendChild(wrap);
    panel.appendChild(row);
  }
  if (spec.test) panel.appendChild(buildTestRow(spec));
}
function buildTestRow(spec){
  var testRow = el('div', 'test-row');
  var testResult = el('span', 'test-result', '');
  testRow.appendChild(button('测试连接', 'test', async function(ev){
    var testBtn = ev.target;
    testBtn.disabled = true; testResult.className = 'test-result'; testResult.textContent = '测试中…';
    try {
      var reqBody = {};
      reqBody[spec.test] = config[spec.test];
      var r = await postJson('/bot/test/' + spec.test, reqBody);
      var payload = (r.json && r.json.result) || {};
      if (payload.ok){ testResult.className = 'test-result ok'; testResult.textContent = '✓ ' + payload.detail + ' · ' + payload.latencyMs + 'ms'; }
      else { testResult.className = 'test-result fail'; testResult.textContent = '✗ ' + (payload.hint || payload.error || '测试失败') + (payload.detail ? '（' + payload.detail + '）' : ''); }
    } catch (e) {
      testResult.className = 'test-result fail'; testResult.textContent = '✗ 测试请求失败：' + String((e && e.message) || e);
    }
    testBtn.disabled = false;
  }));
  testRow.appendChild(testResult);
  return testRow;
}
function promptBlock(title, text){
  var wrap = el('div', 'preview-block');
  wrap.appendChild(el('div', 'preview-title', title));
  wrap.appendChild(el('pre', 'preview', text && text !== '' ? text : '（空）'));
  return wrap;
}
function renderPromptPanel(panel){
  panel.appendChild(el('div', 'panel-title', '组装后的提示词（只读）'));
  panel.appendChild(hint('DSH 主 Agent 实际使用的人格提示词，以及语音模式在句首附加的提示词前缀。'));
  var bar = el('div', 'test-row');
  bar.appendChild(button('刷新预览', 'test', function(){ loadPromptPreview(true); }));
  if (promptLoading) bar.appendChild(el('span', 'test-result', '加载中…'));
  if (promptError) bar.appendChild(el('span', 'test-result fail', promptError));
  panel.appendChild(bar);
  var box = el('div', 'preview-box');
  if (promptLoading){
    box.appendChild(hint('加载中…'));
  } else if (promptPreview && promptPreview.wired){
    box.appendChild(promptBlock('DSH 人格提示词', promptPreview.personaPrompt));
    box.appendChild(promptBlock('语音模式提示词前缀', promptPreview.voicePrefix));
    if (promptPreview.variables && promptPreview.variables.length) box.appendChild(hint('检测到变量占位：' + promptPreview.variables.join('、')));
    if (promptPreview.sources){
      var keys = Object.keys(promptPreview.sources);
      var lines = [];
      for (var i = 0; i < keys.length; i++) lines.push(keys[i] + '：' + promptPreview.sources[keys[i]]);
      if (lines.length) box.appendChild(hint('来源提示：' + lines.join('；')));
    }
    if (promptPreview.note) box.appendChild(hint(promptPreview.note));
  } else if (promptPreview && promptPreview.note){
    box.appendChild(hint(promptPreview.note));
  } else {
    box.appendChild(hint('提示词预览未接线：Lead 需要在 main.ts 传入 onPromptPreview hook。'));
  }
  panel.appendChild(box);
  panel.appendChild(el('div', 'divider'));
  panel.appendChild(el('div', 'panel-title', '高级：自定义人格提示词（覆盖默认）'));
  var ta = document.createElement('textarea');
  ta.className = 'prompt-override';
  ta.rows = 8;
  ta.placeholder = '留空 = 使用默认人格提示词';
  ta.value = (config.persona && config.persona.promptOverride) || '';
  ta.oninput = function(ev){
    if (!config.persona) config.persona = {};
    config.persona.promptOverride = ev.target.value;
    markDirty();
  };
  panel.appendChild(ta);
  panel.appendChild(hint('非空时替代默认人格提示词（仍会附加「事实来自 DSH」约束）；留空恢复默认。保存后生效。'));
  var actions = el('div', 'test-row');
  actions.appendChild(button('保存提示词', 'test', function(){
    if (!config.persona) config.persona = {};
    config.persona.promptOverride = ta.value;
    saveConfig();
  }));
  actions.appendChild(button('恢复默认', 'plain', function(){
    if (!config.persona) config.persona = {};
    config.persona.promptOverride = '';
    ta.value = '';
    saveConfig();
  }));
  panel.appendChild(actions);
}
function buildCheckboxRow(label, description, key, checked){
  var row = el('div', 'row');
  row.appendChild(el('div', 'label', label));
  var wrap = el('div', 'field');
  var box = document.createElement('input');
  box.type = 'checkbox'; box.checked = checked;
  box.onchange = function(ev){
    if (!config.behavior) config.behavior = {pauseOnInput:true, allowScreenView:false};
    config.behavior[key] = ev.target.checked;
    markDirty();
  };
  wrap.appendChild(box);
  wrap.appendChild(hint(description));
  row.appendChild(wrap);
  return row;
}
function renderPermissionsPanel(panel){
  var approval = config.approval || {mode:'ask-each', onceMinutes:10};
  panel.appendChild(el('div', 'panel-title', '审批粒度'));
  panel.appendChild(hint('Bot 代替你操作电脑时，什么时候需要你确认。保存后由后台 Agent / 桌宠按此执行。'));
  var modes = [
    ['ask-each', '每次操作都问', '每个工具调用前都弹出审批气泡（最谨慎，默认）。'],
    ['ask-before-acting', '操作前批一次', '执行一组操作前确认一次，组内自动继续。'],
    ['ask-once', '一次授权 N 分钟', '确认一次后在 N 分钟内不再询问。'],
    ['never-ask', '从不询问', '不再弹出审批（危险：Bot 可以直接改动电脑）。']
  ];
  for (var i = 0; i < modes.length; i++){
    (function(mode, label, description){
      var row = el('label', 'radio-row');
      var radio = document.createElement('input');
      radio.type = 'radio'; radio.name = 'approvalMode'; radio.value = mode;
      radio.checked = approval.mode === mode;
      radio.onchange = function(){
        if (!config.approval) config.approval = {mode:mode, onceMinutes:10};
        config.approval.mode = mode;
        markDirty();
        render();
      };
      var body = el('div', 'radio-body');
      body.appendChild(el('div', 'radio-label', label));
      body.appendChild(el('div', 'hint', description));
      row.appendChild(radio);
      row.appendChild(body);
      panel.appendChild(row);
    })(modes[i][0], modes[i][1], modes[i][2]);
  }
  var minutesRow = el('div', 'row');
  minutesRow.appendChild(el('div', 'label', '授权时长（分钟）'));
  var minutesWrap = el('div', 'field');
  var minutes = document.createElement('input');
  minutes.type = 'number'; minutes.min = '1'; minutes.max = '240'; minutes.step = '1';
  minutes.value = String(approval.onceMinutes || 10);
  minutes.disabled = approval.mode !== 'ask-once';
  minutes.oninput = function(ev){
    if (!config.approval) config.approval = {mode:'ask-once', onceMinutes:10};
    config.approval.onceMinutes = Number(ev.target.value);
    markDirty();
  };
  minutesWrap.appendChild(minutes);
  minutesWrap.appendChild(hint('仅在「一次授权 N 分钟」模式下生效（1–240 分钟）。'));
  minutesRow.appendChild(minutesWrap);
  panel.appendChild(minutesRow);
  panel.appendChild(el('div', 'divider'));
  panel.appendChild(el('div', 'panel-title', '行为'));
  var behavior = config.behavior || {pauseOnInput:true, allowScreenView:false};
  panel.appendChild(buildCheckboxRow('碰键鼠立即暂停', '检测到你主动使用鼠标/键盘时，暂停正在进行的任务并等你指示。', 'pauseOnInput', behavior.pauseOnInput !== false));
  panel.appendChild(buildCheckboxRow('允许查看屏幕', '允许 Bot 截取屏幕内容（需要系统屏幕录制权限）。', 'allowScreenView', behavior.allowScreenView === true));
  panel.appendChild(hint('审批模式与行为开关保存在 Bot 配置（config.json，权限 0600）里，实际执行由 main.ts / host-integration / 桌宠接线后生效。'));
}
function memoryItemNode(item){
  var row = el('div', 'mem-item');
  var head = el('div', 'mem-head');
  head.appendChild(el('span', 'mem-kind', item.kind || 'fact'));
  if (item.date) head.appendChild(el('span', 'mem-date', formatDate(item.date)));
  head.appendChild(el('span', 'mem-id', item.id ? String(item.id).slice(0, 8) : '—'));
  if (item.namespace && item.namespace !== 'global') head.appendChild(el('span', 'mem-ns', item.namespace));
  row.appendChild(head);
  if (mem.editingId === item.id){
    var ta = document.createElement('textarea');
    ta.value = mem.editText; ta.rows = 4;
    ta.oninput = function(ev){ mem.editText = ev.target.value; };
    row.appendChild(ta);
    var editingActions = el('div', 'mem-actions');
    editingActions.appendChild(button('保存纠正', 'test', function(){ correctMemory(item); }));
    editingActions.appendChild(button('取消', 'plain', function(){ mem.editingId = ''; mem.editText = ''; render(); }));
    row.appendChild(editingActions);
  } else {
    row.appendChild(el('div', 'mem-text', item.text || ''));
    var actions = el('div', 'mem-actions');
    actions.appendChild(button('编辑', 'plain', function(){ mem.editingId = item.id; mem.editText = item.text || ''; mem.historyId = ''; render(); }));
    actions.appendChild(button('删除', 'plain', function(){ deleteMemory(item); }));
    actions.appendChild(button('历史', 'plain', function(){ loadMemoryHistory(item); }));
    row.appendChild(actions);
  }
  if (mem.historyId === item.id) row.appendChild(historyNode());
  return row;
}
function historyNode(){
  var box = el('div', 'mem-history');
  box.appendChild(el('div', 'hist-title', '编辑历史'));
  if (mem.historyNote) box.appendChild(hint(mem.historyNote));
  for (var i = 0; i < mem.history.length; i++){
    var entry = mem.history[i];
    var line = el('div', 'hist-row');
    var label = entry.action === 'correct' ? '纠正' : entry.action === 'delete' ? '删除' : '变更';
    var meta = formatDate(entry.at) + ' · ' + label + (entry.ok === false ? '（失败）' : '') + (entry.source === 'remote' ? ' · 后端版本' : ' · 本页操作');
    line.appendChild(el('div', 'hist-meta', meta));
    if (entry.previousText) line.appendChild(el('div', 'hist-old', '旧：' + entry.previousText));
    if (entry.text) line.appendChild(el('div', 'hist-new', '新：' + entry.text));
    if (entry.note) line.appendChild(hint(entry.note));
    box.appendChild(line);
  }
  return box;
}
function renderMemoryPanel(panel){
  var row = el('div', 'row');
  row.appendChild(el('div', 'label', '启用长期记忆'));
  var wrap = el('div', 'field');
  var toggle = document.createElement('input');
  toggle.type = 'checkbox';
  toggle.checked = (config.memory || {}).enabled !== false;
  toggle.onchange = function(ev){
    if (!config.memory) config.memory = {enabled:true};
    config.memory.enabled = ev.target.checked;
    markDirty();
  };
  wrap.appendChild(toggle);
  wrap.appendChild(hint('关闭后 Bot 不再写入/读取长期记忆（保存后需重启记忆服务）。'));
  row.appendChild(wrap);
  panel.appendChild(row);
  var statusLine = el('div', 'hint', '记忆服务：读取中…');
  statusLine.id = 'memory-status';
  panel.appendChild(statusLine);
  panel.appendChild(el('div', 'divider'));
  panel.appendChild(el('div', 'panel-title', '记忆管理'));
  panel.appendChild(hint('查看全部记忆、逐条纠正/删除；本页发起的纠正与删除会记录在本地编辑历史里。'));
  var toolbar = el('div', 'mem-toolbar');
  var searchInput = document.createElement('input');
  searchInput.placeholder = '搜索记忆（例如：我的偏好）';
  searchInput.value = mem.query;
  searchInput.oninput = function(ev){ mem.query = ev.target.value; };
  toolbar.appendChild(searchInput);
  toolbar.appendChild(button('搜索', 'test', function(){ runMemorySearch(); }));
  toolbar.appendChild(button('查看全部', 'test', function(){ loadMemoryList(true); }));
  toolbar.appendChild(button('刷新', 'plain', function(){ loadMemoryList(!mem.loaded || mem.mode === 'list'); }));
  toolbar.appendChild(button('导出', 'plain', function(){ exportMemory(); }));
  toolbar.appendChild(button('清空', 'plain', function(){ forgetMemory(); }));
  panel.appendChild(toolbar);
  if (mem.message) panel.appendChild(el('div', 'mem-message', mem.message));
  var list = el('div', 'mem-list');
  if (mem.loading) list.appendChild(hint('加载中…'));
  else if (!mem.loaded) list.appendChild(hint('点击「查看全部」加载全部记忆，或输入关键字搜索。'));
  else if (!mem.list.length) list.appendChild(hint(mem.note || (mem.mode === 'search' ? '没有找到相关记忆。' : '没有记忆。')));
  else for (var i = 0; i < mem.list.length; i++) list.appendChild(memoryItemNode(mem.list[i]));
  panel.appendChild(list);
  if (mem.mode === 'list' && mem.loaded && mem.list.length){
    var pager = el('div', 'mem-pager');
    var prev = button('上一页', 'plain', function(){ if (mem.offset <= 0) return; mem.offset = Math.max(0, mem.offset - mem.limit); loadMemoryList(false); });
    prev.disabled = mem.offset <= 0;
    var next = button('下一页', 'plain', function(){ if (!mem.hasMore) return; mem.offset = mem.offset + mem.limit; loadMemoryList(false); });
    next.disabled = !mem.hasMore;
    pager.appendChild(prev);
    pager.appendChild(el('span', 'hint', '第 ' + (mem.offset + 1) + '–' + (mem.offset + mem.list.length) + ' 条' + (mem.hasMore ? '（还有更多）' : '')));
    pager.appendChild(next);
    panel.appendChild(pager);
  }
  refreshMemoryStatus();
  if (window.__memoryTimer) clearInterval(window.__memoryTimer);
  window.__memoryTimer = setInterval(function(){ if (active === 'memory') refreshMemoryStatus(); }, 6000);
  if (!mem.loaded && !mem.loading && !mem.autoStarted){
    mem.autoStarted = true;
    setTimeout(function(){ if (active === 'memory' && !mem.loaded && !mem.loading) loadMemoryList(true); }, 0);
  }
}
async function refreshMemoryStatus(){
  var target = document.getElementById('memory-status');
  if (!target) return;
  var r = await api('/bot/memory/status');
  var st = (r.json && r.json.status) || {};
  var text = '';
  if (!st.enabled) text = '记忆服务：已关闭';
  else if (st.sidecar) text = '记忆服务：运行中 · 库 ' + (st.bank || '-') + ' · 数据 ' + (st.dataRoot || '-');
  else text = '记忆服务：未就绪 · ' + (st.error || '');
  target.textContent = text;
}
async function loadMemoryList(reset){
  if (mem.loading) return;
  if (reset) mem.offset = 0;
  mem.mode = 'list'; mem.loading = true; mem.message = ''; mem.editingId = ''; mem.historyId = ''; mem.history = []; mem.historyNote = '';
  render();
  var r = await postJson('/bot/memory/list', {query: mem.query, limit: mem.limit, offset: mem.offset});
  mem.loading = false;
  if (r.json && r.json.ok === true && r.json.result){
    var result = r.json.result;
    mem.available = result.available !== false;
    mem.list = result.items || [];
    mem.hasMore = result.hasMore === true;
    mem.note = result.note || '';
    mem.loaded = true;
    mem.message = mem.available ? '' : (result.note || '记忆服务不可用');
  } else {
    mem.available = false; mem.list = []; mem.hasMore = false; mem.loaded = true;
    mem.message = '读取记忆失败：' + errorText(r.json);
  }
  render();
}
async function runMemorySearch(){
  if (mem.loading) return;
  mem.loading = true; mem.mode = 'search'; mem.message = ''; mem.editingId = ''; mem.historyId = ''; mem.history = []; mem.historyNote = '';
  render();
  var r = await postJson('/bot/memory/search', {query: mem.query, limit: 20, budgetTokens: 1200});
  mem.loading = false;
  var hits = (r.json && r.json.ok === true && r.json.result && r.json.result.hits) || null;
  if (hits === null){
    mem.list = []; mem.loaded = true; mem.hasMore = false;
    mem.message = '搜索失败：' + errorText(r.json);
  } else {
    var items = [];
    for (var i = 0; i < hits.length; i++){
      var h = hits[i] || {};
      items.push({
        id: String(h.id || ''),
        text: String(h.text || h.content || ''),
        kind: String(h.kind || 'fact'),
        namespace: String(h.namespace || 'global'),
        date: String(h.date || h.updatedAt || h.mentioned_at || ''),
        documentId: h.documentId || h.document_id || ''
      });
    }
    mem.list = items; mem.loaded = true; mem.hasMore = false; mem.note = '';
    mem.message = items.length ? '' : '没有找到相关记忆。';
  }
  render();
}
async function correctMemory(item){
  var text = String(mem.editText || '').trim();
  if (text === ''){ mem.message = '纠正内容不能为空。'; render(); return; }
  mem.loading = true; mem.message = ''; render();
  var r = await postJson('/bot/memory/correct', {id: item.id, text: text, kind: item.kind, namespace: item.namespace, previousText: item.text, previousKind: item.kind});
  mem.loading = false;
  var result = (r.json && r.json.result) || {};
  var ok = r.json && r.json.ok === true && result.ok !== false;
  if (ok){
    mem.message = '已纠正：' + (result.note || '新内容已写入，旧条目已删除。');
    mem.editingId = ''; mem.editText = '';
    await loadMemoryList(false);
    return;
  }
  mem.message = '纠正失败：' + errorText(r.json, result.error || result.note);
  render();
}
async function deleteMemory(item){
  if (!window.confirm('删除这条记忆？删除后不再参与回忆（可在导出中找回历史导出）。')) return;
  mem.loading = true; mem.message = ''; render();
  var r = await postJson('/bot/memory/delete', {id: item.id, previousText: item.text, kind: item.kind, namespace: item.namespace});
  mem.loading = false;
  var result = (r.json && r.json.result) || {};
  var ok = r.json && r.json.ok === true && result.ok !== false;
  if (ok){
    mem.message = '已删除。';
    await loadMemoryList(false);
    return;
  }
  mem.message = '删除失败：' + errorText(r.json, result.error || result.note);
  render();
}
async function loadMemoryHistory(item){
  mem.historyId = item.id; mem.history = []; mem.historyNote = '加载中…';
  render();
  var r = await postJson('/bot/memory/history', {id: item.id, documentId: item.documentId, limit: 50});
  mem.history = [];
  if (r.json && r.json.ok === true && r.json.result){
    mem.history = r.json.result.entries || [];
    mem.historyNote = mem.history.length ? '' : '暂无本页发起的纠正/删除记录。';
  } else {
    mem.historyNote = '历史读取失败：' + errorText(r.json);
  }
  render();
}
async function exportMemory(){
  mem.message = '导出中…'; render();
  var r = await postJson('/bot/memory/export');
  var result = (r.json && r.json.result) || {};
  var exported = result.export || result;
  if (r.json && r.json.ok === true && result.ok !== false){
    mem.message = '已导出' + (exported && exported.path ? '：' + exported.path : '') + (exported && exported.count !== undefined ? '（' + exported.count + ' 条）' : '');
  } else {
    mem.message = '导出失败：' + errorText(r.json, result.error || result.note);
  }
  render();
}
async function forgetMemory(){
  if (!window.confirm('清空全部长期记忆？此操作不可撤销。')) return;
  mem.message = '清空中…'; render();
  var r = await postJson('/bot/memory/forget');
  var result = (r.json && r.json.result) || {};
  if (r.json && r.json.ok === true && result.ok !== false){
    mem.list = []; mem.loaded = true; mem.hasMore = false;
    mem.message = '已清空长期记忆。';
  } else {
    mem.message = '清空失败：' + errorText(r.json, result.error || result.note);
  }
  render();
}
async function loadPromptPreview(force){
  if (promptLoading) return;
  if (!force && promptLoaded) return;
  promptLoading = true; promptError = '';
  render();
  var r = await api('/bot/prompt/preview');
  promptLoading = false; promptLoaded = true;
  if (r.json && r.json.ok === true && r.json.result){ promptPreview = r.json.result; }
  else { promptPreview = null; promptError = '预览读取失败：' + errorText(r.json); }
  render();
}
async function saveConfig(){
  if (!config) return;
  if (statusNode) statusNode.textContent = '保存中…';
  var r = await putJson('/bot/config', config);
  if (r.json && r.json.ok === true && r.json.config){
    config = r.json.config;
    if (statusNode) statusNode.textContent = '已保存';
    render();
    if (active === 'prompt') loadPromptPreview(true);
  } else if (statusNode){
    statusNode.textContent = '保存失败：' + errorText(r.json);
  }
}
async function pollRuntime(){
  var r = await api('/bot/status');
  var st = r.json && r.json.status;
  var runtime = document.getElementById('runtime');
  if (!runtime) return;
  runtime.textContent = st ? ('语音网关：' + (st.gateway ? '运行中 pid ' + st.pid : '未运行') + ' · ' + (st.error || st.voiceDir || '')) : '语音网关：未配置';
}
async function loadConfig(){
  var r = await api('/bot/config');
  if (r.json && r.json.ok === true && r.json.config){ config = r.json.config; render(); }
  else if (panelsNode){ panelsNode.textContent = '配置读取失败：' + errorText(r.json); }
}
statusNode = document.getElementById('status');
tabsNode = document.getElementById('tabs');
panelsNode = document.getElementById('panels');
document.getElementById('save').onclick = saveConfig;
document.getElementById('restart').onclick = async function(){
  if (statusNode) statusNode.textContent = '重启中…';
  var r = await api('/bot/restart', {method:'POST'});
  if (statusNode) statusNode.textContent = (r.json && r.json.ok) ? '已重启' : '重启失败';
  var runtime = document.getElementById('runtime');
  if (runtime) runtime.textContent = JSON.stringify((r.json && r.json.status) || null);
};
pollRuntime(); setInterval(pollRuntime, 3000); loadConfig();
</script></body></html>`
}
