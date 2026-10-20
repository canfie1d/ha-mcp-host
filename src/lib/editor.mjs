// HTML for the status page and the apps.json editor.
// Served behind HA ingress; every URL is relative.

export const BASE_CSS = `
:root{color-scheme:light;--bg:#f3f4f6;--fg:#1c1e21;--muted:#5c6570;--line:#d5dbe3;--card:#fff;--ok:#137333;--bad:#c5221f;--warn:#8a5a00;--accent:#0b6b4a;--field:#fff;--shadow:0 1px 0 rgba(28,30,33,.04)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111111;--fg:#e8eaed;--muted:#9aa0a6;--line:#2c333a;--card:#1a1e23;--ok:#3dd68c;--bad:#ff7b72;--warn:#e6b450;--accent:#7dcea0;--field:#12161a;--shadow:none}}
html,body{background:var(--bg);color:var(--fg)}
body{font:14px/1.45 Roboto,Noto,"Segoe UI",system-ui,sans-serif;margin:0;padding:8px 4px 40px}
h1{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:0}
h2{font-size:16px;font-weight:650;margin:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:4px 0 18px}
.overall{margin:2px 0 0;color:var(--muted);font-size:13px}
a.btn,button{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none}
a.btn:hover,button:hover{border-color:var(--muted);text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
.panel{border:1px solid var(--line);border-radius:10px;background:var(--card);box-shadow:var(--shadow);padding:14px 16px}
.hint{color:var(--muted);font-size:13px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
`;

const STATUS_LABEL = {
  healthy: 'healthy',
  unhealthy: 'unhealthy',
  failed: 'failed',
  healing: 'healing',
  starting: 'starting',
  'needs-secrets': 'needs secrets',
};

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function overallLine(snaps) {
  if (!snaps.length) return 'Overall: no apps';
  const bad = snaps.filter((s) => s.status === 'unhealthy' || s.status === 'failed').length;
  const busy = snaps.filter((s) => s.status === 'healing' || s.status === 'starting' || s.status === 'needs-secrets').length;
  const warn = snaps.filter((s) => s.warning).length;
  if (bad) return `Overall: ${bad} unhealthy`;
  if (busy) return `Overall: ${busy} in progress`;
  if (warn) return 'Overall: needs attention';
  return 'Overall: ok';
}

function card(s) {
  const status = STATUS_LABEL[s.status] ? s.status : 'unknown';
  const label = STATUS_LABEL[s.status] || s.status || 'unknown';
  const detail = s.detail ? esc(s.detail) : '—';
  const detailClass = s.warning ? 'detail warn' : 'detail';
  return `<article class="card ${esc(status)}">
<div class="card-top"><h2>${esc(s.name)}</h2><span class="pill ${esc(status)}">${esc(label)}</span></div>
<p class="desc">${esc(s.description || '')}</p>
<dl>
<div><dt>Port</dt><dd>${esc(s.port)}</dd></div>
<div><dt>Last good</dt><dd class="mono">${esc(s.lastGood || '—')}</dd></div>
<div><dt>Patches today</dt><dd>${esc(s.patchesToday)}</dd></div>
</dl>
<p class="${detailClass}">${detail}</p>
</article>`;
}

function incidentItem(i) {
  const failure = i.failure ? ` — ${esc(i.failure)}` : '';
  return `<li><time datetime="${esc(i.at)}">${esc(i.at)}</time><div class="inc-main"><b>${esc(i.app)}</b> ${esc(i.resolvedBy || 'unresolved')}<span class="inc-fail">${failure}</span></div></li>`;
}

function settingsLink(settingsUrl) {
  return settingsUrl ? `<a class="btn" href="${esc(settingsUrl)}" target="_top">App settings</a>` : '';
}

export function statusPage(snaps, incidents, settingsUrl = null) {
  const described = snaps.some((s) => s.description) ? ' has-desc' : '';
  const cards = snaps.length
    ? `<div class="grid${described}">${snaps.map(card).join('')}</div>`
    : `<section class="panel empty"><h2>No apps yet</h2><p>Add one in <a href="apps">apps.json</a>. The host builds it and keeps it healthy.</p></section>`;
  const items = incidents.length
    ? `<ul class="incidents">${incidents.map(incidentItem).join('')}</ul>`
    : '<p class="hint empty-inc">None yet.</p>';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light">
<title>MCP Host</title>
<meta http-equiv="refresh" content="30">
<style>${BASE_CSS}
body.status{max-width:860px;margin:0 auto;padding:24px 16px 40px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
.card{border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);padding:16px;min-width:0}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.card-top h2{word-break:break-word}
.pill{flex:none;font-size:12px;font-weight:650;line-height:1.5;padding:0 8px;border:1px solid currentColor;border-radius:999px}
.pill.healthy{color:var(--ok)}.pill.unhealthy,.pill.failed{color:var(--bad)}.pill.healing,.pill.starting,.pill.needs-secrets,.pill.unknown{color:var(--warn)}
.desc:empty{display:none}
.has-desc .desc{display:-webkit-box;margin:8px 0 0;min-height:2.6em;color:var(--muted);font-size:13px;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}
dl{margin:12px 0 0}
dl div{display:grid;grid-template-columns:7.5rem 1fr;gap:8px;padding:3px 0;font-size:13.5px}
dt{color:var(--muted);font-weight:400}
dd{margin:0;text-align:right;overflow-wrap:anywhere}
dd.mono{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.detail{margin:12px 0 0;padding-top:10px;border-top:1px solid var(--line);color:var(--muted);font-size:13px;overflow-wrap:anywhere}
.detail.warn,.card.needs-secrets .detail,.card.healing .detail,.card.starting .detail{color:var(--warn)}
.card.unhealthy .detail,.card.failed .detail{color:var(--bad)}
.section-title{margin:28px 0 10px}
.panel{margin-top:0;border-radius:14px;padding:16px}
.panel.empty p,.empty-inc{margin:8px 0 2px}
.panel p{margin:0}
.incidents{list-style:none;margin:8px 0 0;padding:0}
.incidents li{padding:10px 0;border-top:1px solid var(--line)}
.incidents time{display:block;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.inc-main{margin-top:2px}
.inc-fail{color:var(--muted)}
</style>
<body class="status">
<header class="top"><div><h1>MCP Host</h1><p class="overall">${esc(overallLine(snaps))}</p></div>${settingsLink(settingsUrl)}</header>
${cards}
<h2 class="section-title">Recent incidents</h2>
<section class="panel">${items}</section>
<h2 class="section-title">Apps</h2>
<section class="panel"><p class="hint">Edit the app definitions, validate, and apply changes live.</p><p style="margin-top:10px"><a class="btn" href="apps">Edit apps.json</a></p></section>`;
}

export function editorPage(settingsUrl = null) {
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light">
<title>MCP Host - Apps</title>
<style>${BASE_CSS}
body.editor{max-width:860px;margin:0 auto;padding:24px 16px 40px}
textarea{width:100%;box-sizing:border-box;min-height:55vh;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px;tab-size:2;resize:vertical}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#msg{margin-top:4px}
#msg ul{margin:6px 0 0;padding-left:20px}
#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}
.lead{margin:0 0 14px}
</style>
<body class="editor">
<header class="top"><div><h1>Apps</h1><p class="overall"><a href="./">Status</a></p></div>${settingsLink(settingsUrl)}</header>
<p class="hint lead">Edits <code>apps.json</code> in the add-on config dir. Saving validates, keeps the previous file as <code>apps.json.bak</code>, and applies the change live: new and edited apps are rebuilt and restarted, removed apps are stopped, untouched apps keep running. Secrets are managed in the add-on Configuration; host ports must be published in the add-on's network settings.</p>
<textarea id=ed spellcheck=false autocomplete=off></textarea>
<div class=bar>
<button id=validate>Validate</button>
<button id=save class=primary>Save &amp; apply</button>
<button id=reload>Reload from disk</button>
<button id=tpl>Add app template</button>
</div>
<div id=msg></div>
<script>
const ed=document.getElementById('ed'),msg=document.getElementById('msg');
const btns=[...document.querySelectorAll('button')];
let loaded='';
function show(cls,html){msg.className=cls;msg.innerHTML=html}
const esc=s=>String(s).replace(/[&<>]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;'}[c]));
const list=(t,a)=>a&&a.length?'<div>'+t+': '+a.map(esc).join(', ')+'</div>':'';
function planHtml(p){
  const h=list('Add',p.added)+list('Rebuild and restart',p.changed)+list('Stop and remove',p.removed)+list('No change',p.unchanged);
  return h||'<div>No apps defined.</div>';
}
async function load(){
  const r=await fetch('api/apps');
  const j=await r.json();
  ed.value=j.text;loaded=j.text;show('','');
}
async function send(dry){
  btns.forEach(b=>b.disabled=true);
  try{
    const r=await fetch('api/apps'+(dry?'?dryRun=1':''),{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({text:ed.value})});
    const j=await r.json();
    if(!j.ok){show('bad','<b>'+(j.errors&&j.errors.length>1?'Problems:':'Problem:')+'</b><ul>'+(j.errors||[j.error]).map(e=>'<li>'+esc(e)+'</li>').join('')+'</ul>');return}
    if(dry)show('ok','<b>Valid.</b> On save:'+planHtml(j.plan));
    else{ed.value=j.text;loaded=j.text;show('ok','<b>Saved and applied.</b>'+planHtml(j.plan)+'<div class=hint>Builds run in the background; watch progress on the <a href="./">status page</a>.</div>')}
  }catch(e){show('bad','Request failed: '+esc(e.message))}
  finally{btns.forEach(b=>b.disabled=false)}
}
document.getElementById('validate').onclick=()=>send(true);
document.getElementById('save').onclick=()=>send(false);
document.getElementById('reload').onclick=async()=>{
  if(ed.value!==loaded&&!confirm('Discard unsaved edits?'))return;
  await load();
};
document.getElementById('tpl').onclick=()=>{
  let o;try{o=JSON.parse(ed.value||'{"apps":[]}')}catch(e){show('bad','Fix the JSON before adding a template: '+esc(e.message));return}
  if(!Array.isArray(o.apps))o.apps=[];
  const used=new Set(o.apps.map(a=>a.port));let port=8101;while(used.has(port))port++;
  o.apps.push({name:'new-app',description:'',repo:'https://github.com/OWNER/REPO.git',ref:'main',install:'npm ci --ignore-scripts',build:'npm run build',start:'node dist/server.js',port,env:{PORT:String(port)},requiredSecrets:[],health:{path:'/health'},mcp:{path:'/mcp',unauthenticatedStatusOk:[401]}});
  ed.value=JSON.stringify(o,null,2)+'\\n';ed.scrollTop=ed.scrollHeight;show('','');
};
ed.addEventListener('keydown',e=>{if(e.key==='Tab'){e.preventDefault();const s=ed.selectionStart;ed.setRangeText('  ',s,ed.selectionEnd,'end')}});
window.addEventListener('beforeunload',e=>{if(ed.value!==loaded){e.preventDefault();e.returnValue=''}});
load().catch(e=>show('bad','Could not load apps.json: '+esc(e.message)));
</script>`;
}
