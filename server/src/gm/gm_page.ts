/** GM 配置页(单文件、零依赖;由 `gm_server.ts` 原样下发)。 */
export const GM_PAGE_HTML = String.raw`<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>绘本沙盒 · GM 端</title>
<style>
:root{--ink:#3e2723;--paper:#fff8ec;--line:#e6cfa5;--accent:#c8553d;--ok:#3d8b5f;--bad:#b3412f;--mute:#8a6f5c}
*{box-sizing:border-box}
body{margin:0;background:#f3e6cd;color:var(--ink);font:15px/1.6 -apple-system,'Segoe UI','Noto Sans SC',sans-serif}
header{background:var(--ink);color:var(--paper);padding:14px 24px;display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:5}
header h1{font-size:18px;margin:0;flex:1}
main{max-width:1100px;margin:0 auto;padding:20px 24px 80px;display:grid;gap:18px}
section{background:var(--paper);border:2px solid var(--line);border-radius:14px;padding:18px 20px}
h2{font-size:16px;margin:0 0 12px}
label{display:block;font-size:13px;color:var(--mute);margin:10px 0 4px}
input[type=text],input[type=password],input[type=number],textarea{width:100%;padding:8px 10px;border:1.5px solid var(--line);border-radius:8px;background:#fff;color:var(--ink);font:inherit}
textarea{min-height:120px;resize:vertical;font-size:14px}
.row{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:12px}
button{font:inherit;padding:8px 16px;border-radius:9px;border:2px solid var(--ink);background:var(--paper);color:var(--ink);cursor:pointer}
button.primary{background:var(--accent);border-color:var(--accent);color:#fff;font-weight:700}
button:disabled{opacity:.5;cursor:wait}
.switch{display:flex;align-items:center;gap:8px;font-weight:700}
.switch input{width:18px;height:18px}
.pill{display:inline-block;padding:1px 10px;border-radius:99px;font-size:12px;font-weight:700;color:#fff;background:var(--mute)}
.pill.ok{background:var(--ok)}.pill.bad{background:var(--bad)}
.npc{border-top:1.5px dashed var(--line);padding-top:14px;margin-top:14px}
.npc:first-of-type{border-top:0;margin-top:0;padding-top:0}
.npc h3{margin:0;font-size:15px;display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.out{margin-top:8px;padding:8px 12px;border-radius:8px;background:#fff;border:1.5px solid var(--line);font-size:14px;white-space:pre-wrap;display:none}
.hint{font-size:13px;color:var(--mute);margin:4px 0 0}
table{border-collapse:collapse;width:100%;font-size:14px}td,th{text-align:left;padding:4px 10px 4px 0;border-bottom:1px solid var(--line)}
details summary{cursor:pointer;color:var(--mute);font-size:13px;margin-top:8px}
#msg{font-size:13px}
</style></head><body>
<header><h1>绘本沙盒 · GM 端</h1><span id="msg"></span>
<button id="reset">恢复默认 prompt</button><button class="primary" id="save">保存并生效</button></header>
<main>
<section><h2>世界现状</h2><div id="status">加载中…</div></section>
<section><h2>NPC 的 AI 端点</h2>
<div class="switch"><input type="checkbox" id="ai_enabled"><span>启用 AI 对话</span>
<span class="pill" id="mode"></span></div>
<p class="hint">关闭、端点没填、超时或返回异常时,NPC 自动说脚本台词(兜底模式),玩家不会卡住。端点需兼容 OpenAI 的 <code>/chat/completions</code>。</p>
<div class="row">
<div><label>接口地址(到 /v1 为止)</label><input type="text" id="baseUrl" placeholder="http://127.0.0.1:3000/v1"></div>
<div><label>模型</label><input type="text" id="model" placeholder="模型名"></div>
<div><label>API Key</label><input type="password" id="apiKey" autocomplete="off"></div>
</div><div class="row">
<div><label>超时(毫秒)</label><input type="number" id="timeoutMs" min="500" max="60000"></div>
<div><label>回复字数上限</label><input type="number" id="maxChars" min="10" max="400"></div>
<div><label>温度</label><input type="number" id="temperature" min="0" max="2" step="0.1"></div>
</div>
<label>世界观与说话规则(所有 NPC 共用)</label><textarea id="worldPrompt" style="min-height:200px"></textarea>
</section>
<section><h2>NPC 人设</h2><div id="npcs"></div></section>
</main>
<script>
const $=id=>document.getElementById(id);let state=null;
const esc=s=>String(s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));
function say(t,bad){$('msg').textContent=t;$('msg').style.color=bad?'#ffb0a0':'#bfe8cf';}
function fill(){
  const a=state.config.ai;
  $('ai_enabled').checked=a.enabled;
  for(const k of['baseUrl','model','apiKey'])$(k).value=a.endpoint[k];
  for(const k of['timeoutMs','maxChars','temperature','worldPrompt'])$(k).value=a[k];
  $('npcs').innerHTML=state.npcs.map(n=>{const c=state.config.npcs[n.id];return '<div class="npc" data-id="'+n.id+'">'
   +'<h3>'+esc(n.name)+' <span class="pill">'+(n.quest?'差事:'+esc(n.quest):'无差事')+'</span>'
   +'<label class="switch" style="margin:0;color:inherit"><input type="checkbox" class="en"'+(c.enabled?' checked':'')+'>用 AI</label>'
   +'<button class="test">试说一句</button></h3>'
   +'<label>人设 prompt</label><textarea class="prompt">'+esc(c.prompt)+'</textarea>'
   +'<details><summary>单独的端点(留空 = 用上面的全局端点)</summary><div class="row">'
   +'<div><label>接口地址</label><input type="text" class="o_baseUrl" value="'+esc(c.endpoint.baseUrl||'')+'"></div>'
   +'<div><label>模型</label><input type="text" class="o_model" value="'+esc(c.endpoint.model||'')+'"></div>'
   +'<div><label>API Key</label><input type="password" class="o_apiKey" value="'+esc(c.endpoint.apiKey||'')+'"></div></div></details>'
   +'<details><summary>兜底脚本台词</summary><p class="hint">'+n.lines.map(esc).join('<br>')+'</p></details>'
   +'<div class="out"></div></div>';}).join('');
  mode();
}
function mode(){const on=$('ai_enabled').checked&&$('baseUrl').value.trim()&&$('model').value.trim();
  $('mode').textContent=on?'AI 模式':'兜底模式(脚本台词)';$('mode').className='pill '+(on?'ok':'');}
function collect(){
  const cfg={ai:{enabled:$('ai_enabled').checked,endpoint:{baseUrl:$('baseUrl').value,model:$('model').value,apiKey:$('apiKey').value},
    timeoutMs:+$('timeoutMs').value,maxChars:+$('maxChars').value,temperature:+$('temperature').value,worldPrompt:$('worldPrompt').value},npcs:{}};
  document.querySelectorAll('.npc').forEach(el=>{cfg.npcs[el.dataset.id]={enabled:el.querySelector('.en').checked,prompt:el.querySelector('.prompt').value,
    endpoint:{baseUrl:el.querySelector('.o_baseUrl').value,model:el.querySelector('.o_model').value,apiKey:el.querySelector('.o_apiKey').value}};});
  return cfg;
}
async function load(){state=await(await fetch('/api/config')).json();fill();}
async function status(){try{const s=await(await fetch('/api/status')).json();const w=s.world;
  const mobs=Object.entries(w.wildlife).map(([k,v])=>esc(k)+' ×'+v).join(' · ')||'(无)';
  const ai=Object.entries(s.ai).map(([k,v])=>'<tr><td>'+esc(k)+'</td><td><span class="pill '+(v.ok?'ok':'bad')+'">'+(v.ok?'AI':'兜底')+'</span></td><td>'+v.ms+' ms</td><td>'+esc(v.text)+'</td></tr>').join('');
  $('status').innerHTML='<p>在线玩家 <b>'+w.players.length+'</b> 人 · 野生动物 <b>'+Object.values(w.wildlife).reduce((a,b)=>a+b,0)+'</b> 只 · 世界帧 '+w.tick+'</p>'
   +(w.players.length?'<table><tr><th>玩家</th><th>等级</th><th>生命</th><th>位置</th></tr>'+w.players.map(p=>'<tr><td>'+esc(p.name||p.id)+'</td><td>'+p.level+'</td><td>'+Math.round(p.hp)+'/'+Math.round(p.maxHp)+'</td><td>'+p.x.toFixed(0)+', '+p.y.toFixed(0)+'</td></tr>').join('')+'</table>':'')
   +'<p class="hint">'+mobs+'</p>'+(ai?'<table><tr><th>NPC 最近一次对话</th><th>来源</th><th>耗时</th><th>内容 / 兜底原因</th></tr>'+ai+'</table>':'');
 }catch(e){$('status').textContent='读不到世界状态:'+e.message;}}
$('save').onclick=async()=>{const r=await(await fetch('/api/config',{method:'PUT',body:JSON.stringify(collect())})).json();
  if(r.ok){state.config=r.config;fill();say('已保存并生效');}else say(r.reason,true);};
$('reset').onclick=async()=>{if(!confirm('把所有 prompt 与参数恢复成默认?端点连接信息保留。'))return;
  const r=await(await fetch('/api/config/reset',{method:'POST'})).json();if(r.ok){state.config=r.config;fill();say('已恢复默认');}};
document.addEventListener('input',mode);
document.addEventListener('click',async e=>{if(!e.target.classList.contains('test'))return;
  const el=e.target.closest('.npc'),out=el.querySelector('.out');e.target.disabled=true;out.style.display='block';out.textContent='请求中…';
  try{const r=await(await fetch('/api/npc/test',{method:'POST',body:JSON.stringify({npcId:el.dataset.id,config:collect()})})).json();
    out.textContent=r.ok?'AI('+r.ms+' ms):'+r.line:'兜底('+r.reason+'):'+r.fallback;}catch(err){out.textContent='请求失败:'+err.message;}
  e.target.disabled=false;});
load();status();setInterval(status,3000);
</script></body></html>`;
