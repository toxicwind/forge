/**
 * flock/ts/strategy/ui-data — /ui data contract for the Flock serve layer.
 *
 * Ported from estate-scripts-router's router_ui.ts. Two exports:
 *
 * - uiData(deps): the /ui/data JSON payload — per-provider key state,
 *   circuit state, Elo, candidate score, serving model counts, and the
 *   free-model list.
 * - FLOCK_UI_HTML: the self-contained dashboard page. It is the legacy
 *   /ui embed contract (fetches /health and /v1/models, posts to
 *   /v1/chat/completions with X-Estate-Strategy). The PRIMARY
 *   dashboard is the separate flock/dashboard Bun app; this module keeps
 *   the /ui contract portable so the Rust proxy can serve a matrix page
 *   without the dashboard app. See ../../dashboard for the full UI.
 */
import { modelFree } from "./catalog.ts";
import type { PolicyBackedDeps } from "./deps.ts";

export function uiData(deps: PolicyBackedDeps): Record<string, unknown> {
  const providers: Record<string, unknown> = {};
  for (const v of deps.providers()) {
    const serving = deps.servingModels(v.name);
    const meta = deps.liveMeta(v.name);
    const free = serving.filter((m) => modelFree(m, meta[m]));
    providers[v.name] = {
      keys: deps.keyOk(v.name) ? "configured" : "missing",
      circuit: deps.circuit.circuitState(v.name),
      elo: Math.round(deps.elo.get(v.name) * 10) / 10,
      candidate_score: Math.round(deps.candidateScore(v.name) * 10) / 10,
      models: serving.length,
      free_models: free,
    };
  }
  return {
    router: "estate-flock",
    version: "v3.1",
    strategy: deps.strategyName,
    providers,
  };
}

export const FLOCK_UI_HTML = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Flock — Provider Matrix</title>
<style>
:root{--bg:#0b0e14;--panel:#121826;--panel2:#0f1420;--ink:#e6edf3;--muted:#8b98a9;--acc:#5ad1c4;--free:#7ee787;--warn:#f0883e;--bad:#ff6b6b;--line:#1f2937}
*{box-sizing:border-box}body{margin:0;font:14px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--bg);color:var(--ink)}
header{padding:18px 22px;border-bottom:1px solid var(--line);display:flex;align-items:center;gap:14px;flex-wrap:wrap}
header h1{font-size:18px;margin:0;letter-spacing:.5px}header .sub{color:var(--muted);font-size:12px}
.wrap{display:grid;grid-template-columns:1.1fr .9fr;gap:16px;padding:18px 22px}
@media(max-width:900px){.wrap{grid-template-columns:1fr}}
.panel{background:var(--panel);border:1px solid var(--line);border-radius:10px;padding:14px}
.panel h2{margin:0 0 10px;font-size:13px;text-transform:uppercase;letter-spacing:1px;color:var(--acc)}
.prov{display:flex;justify-content:space-between;align-items:center;padding:8px 10px;border:1px solid var(--line);border-radius:8px;margin-bottom:8px;background:var(--panel2)}
.prov .name{font-weight:600}.chip{font-size:11px;padding:2px 8px;border-radius:999px;border:1px solid var(--line)}
.chip.ok{color:var(--free);border-color:#234d2b}.chip.no{color:var(--muted);border-color:#2a3340}
.chip.open{color:var(--bad);border-color:#4d2326}.chip.half{color:var(--warn);border-color:#4d3a23}
.tag{font-size:11px;padding:2px 7px;border-radius:6px;background:#0c111b;border:1px solid var(--line);color:var(--muted)}
.tag.free{color:var(--free);border-color:#234d2b}.tag.local{color:var(--acc);border-color:#1d3b39}
textarea,input,select{width:100%;background:var(--panel2);border:1px solid var(--line);color:var(--ink);border-radius:8px;padding:9px;font:inherit}
textarea{min-height:90px;resize:vertical}.row{display:flex;gap:8px;margin-bottom:8px}
button{background:var(--acc);color:#04201d;border:0;border-radius:8px;padding:9px 14px;font-weight:700;cursor:pointer}
pre{background:#06090f;border:1px solid var(--line);border-radius:8px;padding:10px;max-height:320px;overflow:auto;white-space:pre-wrap;word-break:break-word;margin:10px 0 0}
.meta{color:var(--muted);font-size:12px;margin-top:6px}
</style></head>
<body><header><h1>Flock</h1><span class="sub" id="sub">loading</span></header>
<div class="wrap"><div class="panel"><h2>Provider Matrix</h2><div id="providers"><span class="meta">loading</span></div></div>
<div class="panel"><h2>Chat (OpenAI-compatible)</h2>
<div class="row"><select id="model"></select>
<select id="strategy"><option value="hybrid">hybrid</option><option value="free">free (local+free cloud)</option><option value="flock_race">flock_race</option><option value="ast_race">ast_race (legacy)</option><option value="sticky_affinity">sticky_affinity</option><option value="weighted_elo">weighted_elo</option><option value="circuit_chain">circuit_chain</option><option value="fifo_flock">fifo_flock</option><option value="fifo_matrix">fifo_matrix (legacy)</option><option value="cascade">cascade</option></select></div>
<textarea id="prompt" placeholder="Ask anything">Hello, identify which model is answering.</textarea>
<div class="row" style="margin-top:8px"><button id="send">Send</button><button id="stream" style="background:var(--panel2);color:var(--ink);border:1px solid var(--line)">Stream</button></div>
<pre id="out">-</pre><div class="meta" id="routed"></div></div></div>
<script>
const api=(p,o)=>fetch(p,o).then(r=>r.json()).catch(e=>({error:String(e)}));
async function load(){
 const h=await api('/health');
 document.getElementById('sub').textContent='v'+(h.version||'?')+' - strategy='+(h.strategy||'?')+' - '+Object.keys(h.providers||{}).length+' providers';
 const sel=document.getElementById('model');const prov=document.getElementById('providers');prov.innerHTML='';
 for(const [name,p] of Object.entries(h.providers||{})){
  const keyed=p.keys==='configured';const circ=(p.circuit||'unknown');
  const cc=circ==='closed'?'ok':(circ==='open'?'open':(circ==='half'?'half':'no'));
  const el=document.createElement('div');el.className='prov';
  el.innerHTML='<div><div class="name">'+name+'</div></div><div style="text-align:right"><div class="chip '+(keyed?'ok':'no')+'">'+(keyed?'key OK':'no key')+'</div><br><div class="chip '+cc+'">'+circ+'</div><br><div class="meta">elo '+(p.elo!=null?p.elo:'?')+' - '+(p.models||0)+' models</div></div>';
  prov.appendChild(el);
 }
 const m=await api('/v1/models');for(const a of (m.data||[]).map(x=>x.id)){const o=document.createElement('option');o.value=a;o.textContent=a;sel.appendChild(o);}
}
document.getElementById('send').onclick=async()=>{
 const out=document.getElementById('out');out.textContent='...';
 const body={model:document.getElementById('model').value,messages:[{role:'user',content:document.getElementById('prompt').value}]};
 const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Estate-Strategy':document.getElementById('strategy').value},body:JSON.stringify(body)});
 const t=await r.text();out.textContent=t.slice(0,4000);
 document.getElementById('routed').textContent='routed: '+(r.headers.get('X-Routed-Via')||'?')+' - '+(r.headers.get('X-Latency')||'?')+'s - '+(r.headers.get('X-Strategy')||'?');
};
document.getElementById('stream').onclick=async()=>{
 const out=document.getElementById('out');out.textContent='';
 const body={model:document.getElementById('model').value,stream:true,messages:[{role:'user',content:document.getElementById('prompt').value}]};
 const r=await fetch('/v1/chat/completions',{method:'POST',headers:{'Content-Type':'application/json','X-Estate-Strategy':document.getElementById('strategy').value},body:JSON.stringify(body)});
 const rd=r.body.getReader();const dec=new TextDecoder();
 while(true){const d=await rd.read();if(d.done)break;out.textContent+=dec.decode(d.value);}
 document.getElementById('routed').textContent='routed: '+(r.headers.get('X-Routed-Via')||'?');
};
load();
</script></body></html>`;
