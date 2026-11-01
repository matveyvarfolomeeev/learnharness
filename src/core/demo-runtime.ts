/** Shared by the sandbox viewer and the builder's browser verification. No host access. */
export const DEMO_BRIDGE_SCRIPT = String.raw`<script>(function(){
var send=function(m){try{parent.postMessage(m,"*")}catch(e){}};
var post=function(){var b=document.body;if(!b)return;var cs=getComputedStyle(b);send({type:"demo-resize",height:Math.ceil(Math.max(b.scrollHeight,b.getBoundingClientRect().height)+(parseFloat(cs.marginTop)||0)+(parseFloat(cs.marginBottom)||0))})};
var config={steps:true,modal:false,visible:true},runtime=null;
window.addEventListener("message",function(e){
  if(e.source!==parent||!e.data||e.data.type!=="lh-demo-config")return;
  ["steps","modal","visible"].forEach(function(k){if(typeof e.data[k]==="boolean")config[k]=e.data[k]});
  if(runtime)runtime.setSteps(config.steps);
});
window.addEventListener("keydown",function(e){
  if(e.key==="Escape"){e.preventDefault();e.stopPropagation();send({type:"demo-escape"});return}
  if(e.key!=="Tab"||!config.modal)return;
  var items=Array.from(document.querySelectorAll('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),a[href],summary,[tabindex="0"]')).filter(function(el){return el.getClientRects().length&&!el.closest('[hidden]')});
  if(!items.length||(e.shiftKey&&document.activeElement===items[0])||(!e.shiftKey&&document.activeElement===items[items.length-1])){
    e.preventDefault();send({type:"demo-focus-boundary",backwards:e.shiftKey});
  }
});
window.addEventListener("error",function(e){send({type:"demo-error",message:e.message||String(e)})});
window.addEventListener("unhandledrejection",function(e){send({type:"demo-error",message:String(e.reason||"Promise rejected")})});
function init(){
  var stages=Array.from(document.querySelectorAll('[data-lh-demo-stage]'));
  var steps=Array.from(document.querySelectorAll('[data-lh-demo-step]'));
  var stage=stages[0],root=stage&&stage.parentElement;
  var supported=stages.length===1&&steps.length>0&&steps.every(function(s){return s.parentElement===root&&s.getAttribute('data-lh-demo-step').trim()});
  if(supported){
    var css=document.createElement('style');
    css.textContent='html[data-lh-demo-layout],html[data-lh-demo-layout] body{height:100%;margin:0;overflow:hidden} [data-lh-demo-root]{display:grid!important;grid-template-columns:minmax(0,1fr);grid-template-rows:minmax(180px,55%) minmax(0,1fr);box-sizing:border-box!important;height:100dvh!important;max-width:none!important;width:100%!important;min-height:0!important;gap:12px;padding:12px!important;margin:0!important} [data-lh-demo-stage]{min-width:0;min-height:0;overflow:auto;box-sizing:border-box} [data-lh-demo-stage] canvas,[data-lh-demo-stage] svg{max-width:100%} [data-lh-demo-reader]{display:flex;flex-direction:column;min-height:0;min-width:0;overflow:hidden} [data-lh-demo-nav]{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:8px 0;flex-shrink:0} [data-lh-demo-nav] span{flex:1;min-width:100px;font-weight:600} [data-lh-demo-nav] button{font:inherit;min-height:36px;padding:4px 10px;border:1px solid #9996;border-radius:6px;background:transparent;color:inherit;cursor:pointer} [data-lh-demo-nav] button:disabled{opacity:.4;cursor:default} [data-lh-demo-prose]{min-height:0;overflow:auto;overscroll-behavior:contain;overflow-wrap:anywhere;padding:0 6px 12px 0} [data-lh-demo-step][hidden]{display:none!important} @media(min-width:880px){[data-lh-demo-root]{grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);grid-template-rows:minmax(0,1fr)}}';
    document.head.appendChild(css);document.documentElement.setAttribute('data-lh-demo-layout','');root.setAttribute('data-lh-demo-root','');
    var reader=document.createElement('section');reader.setAttribute('data-lh-demo-reader','');reader.setAttribute('aria-label','Пояснения к демонстрации');
    var nav=document.createElement('nav');nav.setAttribute('data-lh-demo-nav','');nav.setAttribute('aria-label','Шаги демонстрации');
    var caption=document.createElement('span');caption.setAttribute('aria-live','polite');
    var prev=document.createElement('button'),next=document.createElement('button');prev.type=next.type='button';prev.textContent='Назад';next.textContent='Далее';
    var prose=document.createElement('div');prose.setAttribute('data-lh-demo-prose','');
    nav.append(caption,prev,next);reader.append(nav,prose);root.appendChild(reader);steps.forEach(function(s){prose.appendChild(s)});
    var index=0,enabled=null;
    function apply(){
      steps.forEach(function(s,i){s.hidden=enabled&&i!==index});
      caption.textContent=enabled?String(index+1)+' / '+steps.length+' · '+steps[index].getAttribute('data-lh-demo-step'):'Все пояснения';
      prev.hidden=next.hidden=!enabled;prev.disabled=index===0;next.disabled=index===steps.length-1;
      window.dispatchEvent(new CustomEvent('lh-demo-step',{detail:{index:index,name:steps[index].getAttribute('data-lh-demo-step'),steps:enabled}}));post();
    }
    function go(i){index=Math.max(0,Math.min(steps.length-1,i));prose.scrollTop=0;apply()}
    prev.addEventListener('click',function(){go(index-1)});next.addEventListener('click',function(){go(index+1)});
    runtime={supported:true,count:steps.length,go:go,setSteps:function(on){if(enabled===on)return;enabled=on;apply()},inspect:function(){
      var issues=[],box=stage.getBoundingClientRect();
      if(stage.scrollWidth>stage.clientWidth+3)issues.push('stage overflows horizontally');
      if(stage.scrollHeight>stage.clientHeight+3)issues.push('stage needs scrolling: keep the plot and controls together');
      if(prose.clientHeight<100)issues.push('not enough room for the explanation');
      if(prose.scrollWidth>prose.clientWidth+3)issues.push('explanation overflows horizontally');
      if(box.bottom>innerHeight+3||box.right>innerWidth+3)issues.push('stage outside viewport');
      if(document.documentElement.scrollWidth>innerWidth+3)issues.push('document overflows horizontally');
      return {supported:true,count:steps.length,index:index,steps:enabled,issues:issues};
    }};
    runtime.setSteps(config.steps);
  }else runtime={supported:false,count:0,setSteps:function(){},inspect:function(){return {supported:false,count:0,issues:['Need one data-lh-demo-stage and named data-lh-demo-step siblings in the same root']}}};
  window.__lhDemoRuntime=runtime;
  send({type:'demo-ready',supportsSteps:runtime.supported});
  if(typeof ResizeObserver!=='undefined')new ResizeObserver(post).observe(document.documentElement);
  post();
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',init,{once:true});else init();
window.addEventListener('resize',post);window.addEventListener('load',post);setTimeout(post,50);setTimeout(post,400);
})();</script>`;

export function buildDemoSrcDoc(html: string): string {
	if (/<\/body>/i.test(html)) return html.replace(/<\/body>/i, `${DEMO_BRIDGE_SCRIPT}</body>`);
	return `${html}${DEMO_BRIDGE_SCRIPT}`;
}
