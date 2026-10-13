// HTML for the apps.json editor. Served at /apps; all URLs are relative so it works behind HA ingress.

export const BASE_CSS = `
:root{color-scheme:light dark;--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--warn:#9a6700;--accent:#0969da;--field:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#161b22;--fg:#e6edf3;--muted:#9198a1;--line:#30363d;--ok:#3fb950;--bad:#f85149;--warn:#d29922;--accent:#4493f8;--field:#0d1117}}
html,body{background:var(--bg);color:var(--fg)}
body{font:15px/1.45 system-ui,-apple-system,sans-serif;margin:0;padding:16px;max-width:900px}
h2,h3{margin:0 0 12px}h3{margin-top:24px}
a{color:var(--accent)}
table{border-collapse:collapse;width:100%}
th,td{padding:8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{color:var(--muted);font-weight:600;font-size:13px}
td:last-child{color:var(--muted);word-break:break-word}
.healthy{color:var(--ok)}.unhealthy,.failed{color:var(--bad)}.healing,.starting,.needs-secrets{color:var(--warn)}
td.healthy,td.unhealthy,td.failed,td.healing,td.starting,td.needs-secrets{font-weight:600;white-space:nowrap}
`;

export function editorPage() {
  return `<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1">
<title>MCP Host - Apps</title>
<style>${BASE_CSS}
nav{margin-bottom:12px}
textarea{width:100%;box-sizing:border-box;min-height:55vh;font:13px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--field);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:10px;tab-size:2;resize:vertical}
.bar{display:flex;flex-wrap:wrap;gap:8px;margin:12px 0}
button{font:inherit;padding:6px 14px;border-radius:6px;border:1px solid var(--line);background:var(--field);color:var(--fg);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff}
button:disabled{opacity:.5;cursor:default}
#msg ul{margin:6px 0 0;padding-left:20px}
#msg.ok{color:var(--ok)}#msg.bad{color:var(--bad)}
.hint{color:var(--muted);font-size:13px}
</style>
<nav><a href="./">&larr; Status</a></nav>
<h2>Apps</h2>
<p class=hint>Edits <code>apps.json</code> in the add-on config dir. Saving validates, keeps the previous file as <code>apps.json.bak</code>, and applies the change live: new and edited apps are rebuilt and restarted, removed apps are stopped, untouched apps keep running. Secrets are managed in the add-on Configuration; host ports must be published in the add-on's network settings.</p>
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
