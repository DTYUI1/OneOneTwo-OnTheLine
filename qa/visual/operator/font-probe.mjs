import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const browser = await chromium.launch(); const page = await browser.newPage();
const results=[];
for(const spec of [
 {label:'title',id:'03',text:'Добавьте службы',x:785,y:299,w:350,h:50,lo:28,hi:37,bg:'#ffffff',fg:'#383838',align:'center',baseline:33},
 {label:'button',id:'02',text:'Дом многоквартирный',x:1189,y:523,w:187,h:31,lo:12,hi:18,bg:'#157dbd',fg:'#ffffff',align:'center',baseline:21},
 {label:'label',id:'02',text:'Угроза людям',x:887,y:647,w:200,h:30,lo:12,hi:18,bg:'#ffffff',fg:'#858585',align:'left',baseline:17}
]) {
const result=await page.evaluate(async ({source,spec:s})=>{
 const image=new Image();image.src=source;await image.decode();const {w,h}=s;
 const ref=Object.assign(document.createElement('canvas'),{width:w,height:h});const rc=ref.getContext('2d');rc.drawImage(image,s.x,s.y,w,h,0,0,w,h);const target=rc.getImageData(0,0,w,h).data;
 const c=Object.assign(document.createElement('canvas'),{width:w,height:h});const ctx=c.getContext('2d');const best=[];
 for(const family of ['Arial','Segoe UI','Calibri','Tahoma','Verdana','Trebuchet MS','Arial Narrow','Roboto']) for(const weight of [400,600,700]) for(let size=s.lo;size<=s.hi;size+=.25) for(let y=s.baseline-2;y<=s.baseline+2;y++) {
 ctx.fillStyle=s.bg;ctx.fillRect(0,0,w,h);ctx.font=`${weight} ${size}px "${family}"`;ctx.fillStyle=s.fg;ctx.textAlign=s.align;ctx.fillText(s.text,s.align==='center'?w/2:0,y);const d=ctx.getImageData(0,0,w,h).data;let error=0;
 for(let i=0;i<d.length;i+=4)error+=Math.abs(d[i]-target[i]);best.push({family,weight,size,y,error});
 }return best.sort((a,b)=>a.error-b.error).slice(0,8);
},{spec,source:'data:image/png;base64,'+readFileSync(`docs/screenshots/card_112/${spec.id}.png`).toString('base64')});results.push({label:spec.label,result});
}
writeFileSync('docs/operator_112_review/stage4/overlay/font-probe.json',JSON.stringify(results,null,2));console.log(results.map(r=>({label:r.label,best:r.result.slice(0,3)})));await browser.close();
