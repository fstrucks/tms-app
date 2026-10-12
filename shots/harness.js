const {chromium,devices}=require('playwright');
const page=(v)=>{const after=v==='after';
const inp=after?"width:100%;min-width:0;box-sizing:border-box;padding:.6rem;font-size:1rem;border-radius:8px;border:1px solid #6b7280;background:#fff;color:#111827;color-scheme:light":"width:100%;box-sizing:border-box;padding:.6rem;font-size:1rem;border-radius:8px;border:1px solid #d1d5db";
const cell=after?"display:block;min-width:0":"";const cols=after?"minmax(0,1fr) minmax(0,1fr)":"1fr 1fr";
const L=(t,c)=>`<label style="${cell}"><span style="display:block;font-size:.85rem;margin-bottom:.25rem">${t}</span>${c}</label>`;
return `<html><head><meta name=viewport content="width=device-width,initial-scale=1"></head><body style="margin:0;padding:1rem;font-family:sans-serif;color-scheme:dark light"><div style="display:grid;grid-template-columns:${cols};gap:.6rem">
${L('Date',`<input id=d type=date value=2026-10-12 style="${inp}">`)}${L('Type',`<select id=t style="${inp}"><option>loaded</option></select>`)}
${L('Start odometer',`<input id=s style="${inp}">`)}${L('End odometer',`<input id=e style="${inp}">`)}</div></body></html>`};
(async()=>{const b=await chromium.launch();
for(const v of ['before','after'])for(const w of [360,390,1280]){
const c=await b.newContext({...devices['Pixel 5'],viewport:{width:w,height:400},colorScheme:'dark',isMobile:w<1000});const p=await c.newPage();await p.setContent(page(v));
const r=await p.evaluate(()=>{const g=id=>document.getElementById(id).getBoundingClientRect();const gap=parseFloat(getComputedStyle(document.querySelector('div')).columnGap);return{dR:g('d').right,tL:g('t').left,sR:g('s').right,eL:g('e').left,gap,docW:document.documentElement.scrollWidth}});
r.ok=r.dR<=r.tL-r.gap+0.5;console.log(v,w,JSON.stringify(r));
if(w===360)await p.screenshot({path:`/workspace/tms-mileagefix/shots/${v}-360.png`});await c.close()}
await b.close()})();
