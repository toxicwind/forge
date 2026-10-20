import { PROVIDERS, STRATEGY, keyOk, catalogModelsFor } from "./router_config.ts";
import { state } from "./router_matrix.ts";

// ---------------------------------------------------------------------------
// UI dashboard (self-contained HTML at /ui)
// ---------------------------------------------------------------------------
export function uiData(): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const name of Object.keys(PROVIDERS)) {
    const serving = catalogModelsFor(name);
    const free = serving.filter((m) => m.includes(":free"));
    providers[name] = {
      keyed: keyOk(name),
      circuit: state.circuit.get(name) || "unknown",
      elo: Math.round((state.elo.get(name) || 1000) * 10) / 10,
      models: serving.length,
      free_models: free,
    };
  }
  return {
    router: "estate-scripts-router-ts",
    version: "v3.1",
    strategy: STRATEGY,
    providers,
  };
}

export const ROUTER_UI_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Estate Router — Provider Matrix</title>
<style>
:root{--bg:#0b0e14;--panel:#121826;--panel2:#0f1420;--ink:#e6edf3;--muted:#8b98a9;--acc:#5ad1c4;--free:#7ee787;--warn:#f0883e;--bad:#ff6b6b;--line:#1f2937}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--ink)}
header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:18px;margin:0;letter-spacing:.5px}header .sub{color:var(--muted);font-size:12px}
.wrap{display:grid;grid-template-columns:1.1fr .9fr;gap:16px;padding:18px 22px;max-width:1400px;margin:0 auto}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px;min-width:0}
.panel h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--acc);display:flex;justify-content:space-between;align-items:center;gap:8px}
.prov{display:flex;justify-content:space-between;align-items:center;gap:10px;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:var(--panel2)}
.prov .name{font-weight:600;overflow-wrap:anywhere;min-width:0}
.prov .chips{display:flex;flex-direction:column;gap:4px;align-items:flex-end;flex-shrink:0}
.chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line);white-space:nowrap}
.chip.ok{color:var(--free);border-color:#234d2b}.chip.no{color:var(--muted);border-color:#2a3340}
.chip.open{color:var(--bad);border-color:#4d2326}.chip.half{color:var(--warn);border-color:#4d3a23}
.tag{font-size:11px;padding:2px 7px;border-radius:6px;background:#0c111b;border:1px solid var(--line);color:var(--muted)}
.tag.free{color:var(--free);border-color:#234d2b}.tag.local{color:var(--acc);border-color:#1d3b39}
textarea,input,select{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px;font:inherit}
textarea{min-height:90px;resize:vertical}.row{display:flex;gap:8px;margin-bottom:8px;flex-wrap:wrap}
.row>*{flex:1 1 0;min-width:0}
@media(max-width:600px){.row{flex-direction:column}.row>*{flex:none}}
.vh{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}
button{background:var(--acc);color:#04201d;border:0;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer}
button.ghost{background:var(--panel2);color:var(--ink);border:1px solid var(--line)}
button:focus-visible,select:focus-visible,textarea:focus-visible{outline:2px solid var(--acc);outline-offset:2px}
button:disabled{opacity:.5;cursor:wait}
pre{background:#06090f;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:10px 0 0}
.meta{color:var(--muted);font-size:12px;margin-top:6px}
.err{color:var(--bad)}
</style></head>
<body><header><h1>Estate Router</h1><span class="sub" id="sub">loading</span></header>
<div class="wrap"><div class="panel"><h2>Provider Matrix <button id="refresh" class="ghost" style="padding:4px 10px;font-size:11px">Refresh</button></h2><div id="providers"><span class="meta">loading</span></div></div>
<div class="panel"><h2>Chat (OpenAI-compatible)</h2>
<div class="row"><div><label class="vh" for="model">Model</label><select id="model"></select></div>
<div><label class="vh" for="strategy">Strategy</label><select id="strategy"><option value="hybrid">hybrid</option><option value="free">free (local+free cloud)</option><option value="flock_race">flock_race</option><option value="ast_race">ast_race (legacy)</option><option value="sticky_affinity">sticky_affinity</option><option value="weighted_elo">weighted_elo</option><option value="circuit_chain">circuit_chain</option><option value="fifo_flock">fifo_flock</option><option value="fifo_matrix">fifo_matrix (legacy)</option></select></div></div>
<label class="vh" for="prompt">Prompt</label><textarea id="prompt" placeholder="Ask anything">Hello, identify which model is answering.</textarea>
<div class="row" style="margin-top:8px"><button id="send">Send</button><button id="stream" class="ghost">Stream</button></div>
<pre id="out">-</pre><div class="meta" id="routed"></div></div></div>
<script>
const $=id=>document.getElementById(id);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const api=async(p,o)=>{try{const r=await fetch(p,o);const j=await r.json().catch(()=>({error:'non-json response'}));return r.ok?j:{error:j.error||('HTTP '+r.status)}}catch(e){return{error:String(e)}}};
function provCard(name,p){
  const keyed=p.keys==='configured';const circ=(p.circuit||'unknown');
  const cc=circ==='closed'?'ok':(circ==='open'?'open':(circ==='half'?'half':'no'));
  const el=document.createElement('div');el.className='prov';
  el.innerHTML='<div class="name">'+esc(name)+'</div><div class="chips">'
    +'<span class="chip '+(keyed?'ok':'no')+'">'+(keyed?'key OK':'no key')+'</span>'
    +'<span class="chip '+cc+'">'+esc(circ)+'</span>'
    +'<span class="meta">elo '+(p.elo!=null?p.elo:'?')+' &middot; '+(p.models||0)+' models'+(p.live_models!=null?' ('+p.live_models+' live)':'')+'</span>'
    +'</div>';
  return el;
}
async function loadMatrix(){
  const box=$('providers');
  const h=await api('/health');
  if(h.error){box.innerHTML='<span class="err">health failed: '+esc(h.error)+'</span>';return;}
  $('sub').textContent='v'+(h.version||'?')+' · strategy='+(h.strategy||'?')+' · '+Object.keys(h.providers||{}).length+' providers';
  box.innerHTML='';
  const entries=Object.entries(h.providers||{});
  if(!entries.length){box.innerHTML='<span class="meta">no providers</span>';return;}
  for(const [name,p] of entries) box.appendChild(provCard(name,p));
}
async function loadModels(){
  const sel=$('model');sel.innerHTML='';
  const m=await api('/v1/models');
  const ids=(m.data||[]).map(x=>x.id);
  if(!ids.length){const o=document.createElement('option');o.textContent='(no models)';sel.appendChild(o);return;}
  for(const a of ids){const o=document.createElement('option');o.value=a;o.textContent=a;sel.appendChild(o);}
}
function busy(b){$('send').disabled=b;$('stream').disabled=b;}
function sseText(raw){
  let out='';
  for(const line of raw.split('\n')){
    const t=line.trim();
    if(!t.startsWith('data:')) continue;
    const d=t.slice(5).trim();
    if(d==='[DONE]') continue;
    try{const j=JSON.parse(d);const c=j.choices&&j.choices[0];out+=(c&&(c.delta&&c.delta.content))||(c&&c.text)||'';}
    catch(e){out+=d;}
  }
  return out;
}
$('send').onclick=async()=>{
  const out=$('out'),model=$('model').value;
  if(!model||model==='(no models)'){out.innerHTML='<span class="err">no model available</span>';return;}
  busy(true);out.textContent='…';
  const r=await api('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Estate-Strategy':$('strategy').value},body:JSON.stringify({model,messages:[{role:'user',content:$('prompt').value}]})});
  busy(false);
  if(r.error){out.innerHTML='<span class="err">'+esc(r.error)+'</span>';return;}
  out.textContent=JSON.stringify(r,null,2).slice(0,6000);
  $('routed').textContent='routed: check X-Routed-Via / X-Latency / X-Strategy response headers';
};
$('stream').onclick=async()=>{
  const out=$('out'),model=$('model').value;
  if(!model||model==='(no models)'){out.innerHTML='<span class="err">no model available</span>';return;}
  busy(true);out.textContent='';
  try{
    const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Estate-Strategy':$('strategy').value},body:JSON.stringify({model,stream:true,messages:[{role:'user',content:$('prompt').value}]})});
    if(!r.ok||!r.body){out.innerHTML='<span class="err">HTTP '+r.status+': '+esc(await r.text().catch(()=>''))+'</span>';}
    else{
      const rd=r.body.getReader();const dec=new TextDecoder();let buf='';
      while(true){const d=await rd.read();if(d.done)break;buf+=dec.decode(d.value,{stream:true});out.textContent=sseText(buf);}
      out.textContent=sseText(buf+dec.decode());
      const via=r.headers.get('X-Routed-Via');if(via)$('routed').textContent='routed: '+via;
    }
  }catch(e){out.innerHTML='<span class="err">'+esc(String(e))+'</span>';}
  busy(false);
};
$('refresh').onclick=()=>{loadMatrix();};
loadMatrix();loadModels();
</script></body></html>`;
