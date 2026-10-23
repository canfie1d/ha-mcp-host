// HTML for the overview, the per-app pages and the apps.json editor.
// Served behind HA ingress; every URL is relative to the <base> the server passes in.

export const BASE_CSS = `
:root{color-scheme:light;--bg:#f3f4f6;--fg:#1c1e21;--muted:#5c6570;--line:#d5dbe3;--card:#fff;--ok:#137333;--bad:#c5221f;--warn:#8a5a00;--accent:#0b6b4a;--field:#fff;--shadow:0 1px 0 rgba(28,30,33,.04);--nav:#eceef1;--sel:rgba(11,107,74,.12)}
@media (prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#111111;--fg:#e8eaed;--muted:#9aa0a6;--line:#2c333a;--card:#1a1e23;--ok:#3dd68c;--bad:#ff7b72;--warn:#e6b450;--accent:#7dcea0;--field:#12161a;--shadow:none;--nav:#16191d;--sel:rgba(125,206,160,.14)}}
html,body{background:var(--bg);color:var(--fg)}
body{font:14px/1.45 Roboto,Noto,"Segoe UI",system-ui,sans-serif;margin:0}
h1{font-size:22px;font-weight:650;letter-spacing:-.01em;margin:0;overflow-wrap:anywhere}
h2{font-size:16px;font-weight:650;margin:0}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}
.top{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin:4px 0 18px}
.overall{margin:2px 0 0;color:var(--muted);font-size:13px}
a.btn,button{font:inherit;font-size:13px;padding:6px 12px;border-radius:8px;border:1px solid var(--line);background:var(--card);color:var(--fg);cursor:pointer;text-decoration:none;white-space:nowrap}
a.btn:hover,button:hover{border-color:var(--muted);text-decoration:none}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
.panel{border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);padding:16px}
.panel p{margin:0}
.hint{color:var(--muted);font-size:13px}
code{font:12.5px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace}
.section-title{margin:28px 0 10px}
.pill{flex:none;font-size:12px;font-weight:650;line-height:1.5;padding:0 8px;border:1px solid currentColor;border-radius:999px}
.healthy{--st:var(--ok)}.unhealthy,.failed{--st:var(--bad)}.healing,.starting,.needs-secrets,.unknown{--st:var(--warn)}
.pill{color:var(--st,var(--warn))}
.notice{margin:0 0 16px;padding:10px 14px;border:1px solid var(--warn);border-radius:10px;color:var(--warn);font-size:13px}
.incidents{list-style:none;margin:8px 0 0;padding:0}
.incidents li{padding:10px 0;border-top:1px solid var(--line)}
.incidents li:first-child{border-top:0;padding-top:0}
.incidents time{display:block;color:var(--muted);font-size:12px;font-variant-numeric:tabular-nums}
.inc-main{margin-top:2px}
.inc-fail{color:var(--muted)}
.shell{display:grid;grid-template-columns:216px minmax(0,1fr);min-height:100vh}
.side{position:sticky;top:0;align-self:start;height:100vh;box-sizing:border-box;overflow-y:auto;display:flex;flex-direction:column;gap:2px;padding:16px 10px;background:var(--nav);border-right:1px solid var(--line)}
.side .brand{font-weight:650;font-size:15px;padding:4px 10px 12px}
.side .group{color:var(--muted);font-size:11.5px;font-weight:650;letter-spacing:.04em;text-transform:uppercase;padding:14px 10px 4px}
.side a{display:flex;align-items:center;gap:9px;padding:7px 10px;border-radius:8px;color:var(--fg);min-width:0}
.side a span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.side a:hover{background:var(--sel);text-decoration:none}
.side a[aria-current]{background:var(--sel);color:var(--accent);font-weight:600}
.side .foot{margin-top:auto;padding-top:14px;display:flex;flex-direction:column;gap:2px}
.side .none{color:var(--muted);font-size:13px;padding:4px 10px}
.dot{flex:none;width:8px;height:8px;border-radius:50%;background:var(--st,var(--muted))}
main{min-width:0;max-width:900px;padding:24px 20px 48px;box-sizing:border-box}
@media (max-width:720px){
.shell{grid-template-columns:minmax(0,1fr)}
.side{position:static;height:auto;flex-direction:row;align-items:center;overflow-x:auto;gap:4px;padding:8px 12px;border-right:0;border-bottom:1px solid var(--line)}
.side .brand,.side .group{display:none}
.side .foot{margin:0;padding:0;flex-direction:row;gap:4px}
.side a{flex:none}
main{padding:18px 16px 40px}
}
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

const statusClass = (s) => (STATUS_LABEL[s] ? s : 'unknown');
const pill = (s) => `<span class="pill ${statusClass(s)}">${esc(STATUS_LABEL[s] || s || 'unknown')}</span>`;
const appHref = (name) => `app/${encodeURIComponent(name)}`;
// Data handed to inline scripts; "<" is escaped so a value can never close the script tag.
const json = (v) => JSON.stringify(v).replace(/</g, '\\u003c');

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

/** Page skeleton shared by every view: the side nav listing each app, then the page's own content. */
function shell({ title, css = '', body, head = '', layout }) {
  const { base, nav, current, settingsUrl } = layout;
  const cur = (key) => (current === key ? ' aria-current="page"' : '');
  const items = nav.length
    ? nav.map((a) => `<a href="${esc(appHref(a.name))}"${cur(a.name)}><i class="dot ${statusClass(a.status)}"></i><span>${esc(a.name)}</span></a>`).join('')
    : '<p class="none">No apps yet</p>';
  const settings = settingsUrl ? `<a href="${esc(settingsUrl)}" target="_top"><span>App settings</span></a>` : '';
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="dark light">
<base href="${esc(base)}">
<title>${esc(title)}</title>${head}
<style>${BASE_CSS}${css}</style>
<body><div class="shell">
<nav class="side" aria-label="MCP Host">
<div class="brand">MCP Host</div>
<a href="./"${cur('')}><span>Overview</span></a>
<div class="group">Apps</div>
${items}
<div class="foot"><a href="apps"${cur('apps')}><span>Edit apps.json</span></a>${settings}</div>
</nav>
<main>${body}</main>
</div>`;
}

function legacyNotice(layout) {
  if (!layout.legacySecrets) return '';
  return `<p class="notice">Secrets are now set on each app's page. The ${layout.legacySecrets} secret(s) still listed in the add-on Configuration were imported once and are no longer read; you can delete them there.</p>`;
}

function card(s) {
  const detail = s.detail ? esc(s.detail) : '—';
  const detailClass = s.warning ? 'detail warn' : 'detail';
  return `<a class="card ${statusClass(s.status)}" href="${esc(appHref(s.name))}">
<div class="card-top"><h2>${esc(s.name)}</h2>${pill(s.status)}</div>
<p class="desc">${esc(s.description || '')}</p>
<dl>
<div><dt>Port</dt><dd>${esc(s.port)}</dd></div>
<div><dt>Last good</dt><dd class="mono">${esc(s.lastGood || '—')}</dd></div>
<div><dt>Patches today</dt><dd>${esc(s.patchesToday)}</dd></div>
</dl>
<p class="${detailClass}">${detail}</p>
</a>`;
}

function incidentItem(i, withApp = true) {
  const failure = i.failure ? ` — ${esc(i.failure)}` : '';
  const who = withApp ? `<b>${esc(i.app)}</b> ` : '';
  return `<li><time datetime="${esc(i.at)}">${esc(i.at)}</time><div class="inc-main">${who}${esc(i.resolvedBy || i.outcome || 'unresolved')}<span class="inc-fail">${failure}</span></div></li>`;
}

const incidentList = (incidents, withApp) => incidents.length
  ? `<ul class="incidents">${incidents.map((i) => incidentItem(i, withApp)).join('')}</ul>`
  : '<p class="hint">None yet.</p>';

const CARD_CSS = `
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(230px,1fr));gap:12px}
a.card{display:block;color:inherit;border:1px solid var(--line);border-radius:14px;background:var(--card);box-shadow:var(--shadow);padding:16px;min-width:0}
a.card:hover{text-decoration:none;border-color:var(--muted)}
.card-top{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}
.card-top h2{word-break:break-word}
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
`;

export function statusPage(snaps, incidents, layout, notice = '') {
  const described = snaps.some((s) => s.description) ? ' has-desc' : '';
  const cards = snaps.length
    ? `<div class="grid${described}">${snaps.map(card).join('')}</div>`
    : `<section class="panel"><h2>No apps yet</h2><p style="margin-top:8px">Add one in <a href="apps">apps.json</a>. The host builds it and keeps it healthy.</p></section>`;
  return shell({
    title: 'MCP Host',
    head: '<meta http-equiv="refresh" content="30">',
    css: CARD_CSS,
    layout,
    body: `${notice ? `<p class="notice">${esc(notice)}</p>` : ''}${legacyNotice(layout)}
<header class="top"><div><h1>Overview</h1><p class="overall">${esc(overallLine(snaps))}</p></div></header>
${cards}
<h2 class="section-title">Recent incidents</h2>
<section class="panel">${incidentList(incidents, true)}</section>`,
  });
}

const APP_CSS = `
.head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;flex-wrap:wrap;margin:4px 0 6px}
.title{display:flex;align-items:center;gap:10px;flex-wrap:wrap;min-width:0}
.actions{display:flex;gap:8px;flex-wrap:wrap}
.lede{margin:0 0 4px;color:var(--muted)}
#detail{margin:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
#detail.warn{color:var(--warn)}#detail.bad{color:var(--bad)}
.facts{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:2px 24px;margin:0}
.facts div{display:grid;grid-template-columns:7rem minmax(0,1fr);gap:8px;padding:6px 0;border-top:1px solid var(--line);font-size:13.5px}
.facts dt{color:var(--muted)}.facts dd{margin:0;overflow-wrap:anywhere}
.mono{font:12.5px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace}
.sub{display:block;color:var(--muted);font-size:12.5px}
.secrets{width:100%;border-collapse:collapse}
.secrets td{padding:8px 0;border-top:1px solid var(--line);vertical-align:middle}
.secrets tr:first-child td{border-top:0}
.secrets td.name{width:38%;padding-right:12px;overflow-wrap:anywhere}
.secrets td.act{width:1%;white-space:nowrap;padding-left:8px}
.tag{display:inline-block;margin-left:6px;font:600 11px/1.6 Roboto,system-ui,sans-serif;padding:0 6px;border-radius:999px;border:1px solid currentColor;vertical-align:1px}
.tag.set{color:var(--ok)}.tag.missing{color:var(--warn)}.tag.extra{color:var(--muted)}
input{font:inherit;font-size:13px;width:100%;box-sizing:border-box;padding:6px 10px;border-radius:8px;border:1px solid var(--line);background:var(--field);color:var(--fg)}
.add{display:grid;grid-template-columns:38% minmax(0,1fr) auto;gap:8px 12px;margin-top:12px;padding-top:12px;border-top:1px solid var(--line)}
#smsg{margin-top:10px;font-size:13px}#smsg:empty{display:none}
#smsg.ok{color:var(--ok)}#smsg.bad{color:var(--bad)}
.logbar{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:28px 0 10px}
.logbar h2{margin:0}
pre#log{margin:0;max-height:420px;overflow:auto;padding:12px 14px;border:1px solid var(--line);border-radius:14px;background:var(--field);font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;overflow-wrap:anywhere}
@media (max-width:560px){.secrets td.name{width:auto}.secrets tr{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:6px}.secrets td{border:0;padding:0}.secrets tr{border-top:1px solid var(--line);padding:10px 0}.secrets tr:first-child{border-top:0;padding-top:0}.secrets td.name{grid-column:1/-1}.add{grid-template-columns:minmax(0,1fr) auto}.add input:first-child{grid-column:1/-1}}
`;

/** One app's page: status and actions, what is deployed, its secrets, live logs and its incidents. */
export function appPage(app, layout) {
  const repoLink = /^https:\/\//.test(app.repo)
    ? `<a href="${esc(app.repo.replace(/\.git$/, ''))}" target="_blank" rel="noopener">${esc(app.repo.replace(/^https:\/\/(github\.com\/)?/, '').replace(/\.git$/, ''))}</a>`
    : esc(app.repo);
  const v = app.version;
  const commit = v
    ? `<span class="mono">${esc(v.sha.slice(0, 8))}</span><span class="sub">${esc(v.subject)}</span><span class="sub">${esc(v.date)}</span>`
    : '<span class="hint">not checked out yet</span>';
  return shell({
    title: `${app.name} · MCP Host`,
    css: APP_CSS,
    layout,
    body: `${legacyNotice(layout)}
<header class="head">
<div class="title"><h1>${esc(app.name)}</h1><span id="pill">${pill(app.status)}</span></div>
<div class="actions"><button id="restart">Restart</button><button id="rebuild" title="Fetch the latest commit on ${esc(app.ref)}, reinstall, rebuild and restart">Pull &amp; rebuild</button></div>
</header>
${app.description ? `<p class="lede">${esc(app.description)}</p>` : ''}
<p id="detail"></p>

<h2 class="section-title">Deployed</h2>
<section class="panel"><dl class="facts">
<div><dt>Version</dt><dd>${esc(v?.pkg || '—')}</dd></div>
<div><dt>Commit</dt><dd>${commit}</dd></div>
<div><dt>Last good</dt><dd class="mono">${esc(app.lastGood || '—')}</dd></div>
<div><dt>Repo</dt><dd>${repoLink} <span class="sub">${esc(app.ref)}</span></dd></div>
<div><dt>Port</dt><dd>${esc(app.port)}</dd></div>
<div><dt>Endpoints</dt><dd><span class="mono">${esc(app.healthPath)}</span>${app.mcpPath ? `<span class="sub">MCP <span class="mono">${esc(app.mcpPath)}</span></span>` : ''}</dd></div>
<div><dt>Patches today</dt><dd>${esc(app.patchesToday)}</dd></div>
</dl></section>

<h2 class="section-title">Secrets</h2>
<section class="panel">
<p class="hint" style="margin-bottom:10px">Passed to the app as environment variables. Values are write-only: they are stored in the add-on's private <code>/data</code> and never shown again. Saving restarts the app.</p>
<table class="secrets"><tbody id="srows"></tbody></table>
<form class="add" id="sadd" autocomplete="off"><input id="sname" placeholder="NEW_SECRET_NAME" spellcheck="false" aria-label="New secret name"><input id="sval" type="password" placeholder="value" aria-label="New secret value"><button class="primary">Add</button></form>
<div id="smsg"></div>
</section>

<div class="logbar"><h2>Logs</h2><span class="hint" id="logstate">live</span></div>
<pre id="log"></pre>

<h2 class="section-title">Incidents</h2>
<section class="panel">${incidentList(app.incidents, false)}</section>

<script>
const NAME=${json(app.name)};
const API='api/app/'+encodeURIComponent(NAME);
let data=${json({ status: app.status, detail: app.detail, warning: app.warning, busy: app.busy, logTail: app.logTail, secrets: app.secrets })};
const LABEL=${json(STATUS_LABEL)};
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const cls=s=>LABEL[s]?s:'unknown';
function renderStatus(){
  $('pill').innerHTML='<span class="pill '+cls(data.status)+'">'+esc(LABEL[data.status]||data.status||'unknown')+'</span>';
  const d=data.busy?data.busy+' in progress…':(data.detail||'');
  $('detail').textContent=d;
  $('detail').className=data.status==='unhealthy'||data.status==='failed'?'bad':data.warning||data.status==='needs-secrets'?'warn':'';
  const locked=!!data.busy||data.status==='healing'||data.status==='needs-secrets';
  $('restart').disabled=$('rebuild').disabled=locked;
}
function renderLogs(){
  const el=$('log'),atEnd=el.scrollHeight-el.scrollTop-el.clientHeight<24;
  el.textContent=(data.logTail||[]).join('\\n')||'No output yet.';
  if(atEnd)el.scrollTop=el.scrollHeight;
  $('logstate').textContent=atEnd?'live':'live · scrolled up';
}
function renderSecrets(){
  const req=data.secrets.required,set=new Set(data.secrets.set);
  const names=[...req,...data.secrets.set.filter(n=>!req.includes(n))];
  $('srows').innerHTML=names.length?names.map(n=>{
    const tag=!req.includes(n)?'<span class="tag extra" title="Not listed in requiredSecrets">extra</span>':set.has(n)?'<span class="tag set">set</span>':'<span class="tag missing">missing</span>';
    return '<tr data-name="'+esc(n)+'"><td class="name"><code>'+esc(n)+'</code>'+tag+'</td>'
      +'<td><input type="password" autocomplete="new-password" placeholder="'+(set.has(n)?'•••••••• (enter to replace)':'value')+'" aria-label="'+esc(n)+' value"></td>'
      +'<td class="act"><button data-op="save">Save</button> '+(set.has(n)?'<button data-op="remove">Remove</button>':'')+'</td></tr>';
  }).join(''):'<tr><td class="hint">This app declares no required secrets.</td></tr>';
}
function smsg(c,h){$('smsg').className=c;$('smsg').innerHTML=h}
async function putSecrets(body){
  const r=await fetch(API+'/secrets',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify(body)});
  const j=await r.json();
  if(!j.ok){smsg('bad',(j.errors||['Save failed']).map(esc).join('<br>'));return false}
  data.secrets.set=j.set;renderSecrets();
  const next=j.deferred?' The app is busy; the new values apply the next time it starts.':j.action==='build'?' All required secrets are set; building and starting now.':j.action==='restart'?' Restarting with the new values.':j.missing.length?' Still missing: '+j.missing.map(esc).join(', ')+'.':'';
  smsg('ok','Saved.'+next);
  refresh();
  return true;
}
$('srows').addEventListener('click',async e=>{
  const b=e.target.closest('button');if(!b)return;
  const row=b.closest('tr'),n=row.dataset.name,input=row.querySelector('input');
  if(b.dataset.op==='remove'){if(confirm('Remove '+n+'?'))await putSecrets({remove:[n]});return}
  if(!input.value){input.focus();smsg('bad','Enter a value for '+esc(n)+' first.');return}
  if(await putSecrets({set:{[n]:input.value}}))input.value='';
});
$('srows').addEventListener('keydown',e=>{if(e.key==='Enter'&&e.target.matches('input')){e.preventDefault();e.target.closest('tr').querySelector('[data-op=save]').click()}});
$('sadd').addEventListener('submit',async e=>{
  e.preventDefault();
  const n=$('sname').value.trim(),v=$('sval').value;
  if(!n||!v){smsg('bad','Enter a name and a value.');return}
  if(await putSecrets({set:{[n]:v}})){$('sname').value='';$('sval').value=''}
});
async function act(op){
  $('restart').disabled=$('rebuild').disabled=true;
  const r=await fetch(API+'/'+op,{method:'POST',headers:{'content-type':'application/json'},body:'{}'});
  if(!r.ok){const j=await r.json().catch(()=>({}));alert((j.errors||['Request failed']).join('\\n'))}
  refresh();
}
$('restart').onclick=()=>act('restart');
$('rebuild').onclick=()=>{if(confirm('Fetch the latest code, rebuild and restart '+NAME+'?'))act('rebuild')};
let timer;
async function refresh(){
  clearTimeout(timer);
  try{
    const r=await fetch(API,{cache:'no-store'});
    if(r.ok){const j=await r.json();data={...data,...j,secrets:data.secrets};renderStatus();renderLogs()}
  }catch{}
  timer=setTimeout(refresh,data.busy||data.status==='starting'||data.status==='healing'?2000:5000);
}
renderStatus();renderLogs();renderSecrets();$('log').scrollTop=$('log').scrollHeight;
timer=setTimeout(refresh,3000);
</script>`,
  });
}

export function editorPage(layout) {
  return shell({
    title: 'Apps · MCP Host',
    layout,
    css: `
textarea{width:100%;box-sizing:border-box;min-height:55vh;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:10px;padding:12px;tab-size:2;resize:vertical}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
#msg{margin-top:4px}
#msg ul{margin:6px 0 0;padding-left:20px}
#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}
.lead{margin:0 0 14px}
`,
    body: `<header class="top"><div><h1>Edit apps.json</h1></div></header>
<p class="hint lead">Edits <code>apps.json</code> in the add-on config dir. Saving validates, keeps the previous file as <code>apps.json.bak</code>, and applies the change live: new and edited apps are rebuilt and restarted, removed apps are stopped, untouched apps keep running. Secrets are set on each app's page; host ports must be published in the add-on's network settings.</p>
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
const btns=[...document.querySelectorAll('main button')];
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
    else{ed.value=j.text;loaded=j.text;show('ok','<b>Saved and applied.</b>'+planHtml(j.plan)+'<div class=hint>Builds run in the background; watch progress on the <a href="./">overview</a>.</div>')}
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
</script>`,
  });
}
