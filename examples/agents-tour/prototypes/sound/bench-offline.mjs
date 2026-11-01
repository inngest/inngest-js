// Throwaway. node bench-offline.mjs /abs/path/index.html 60 : renders the synth loop offline and prints node counts and render time. Edit `bin` to your Chromium.
import {spawn} from "node:child_process";
import {mkdtempSync} from "node:fs";
import {tmpdir} from "node:os";
const file=process.argv[2],secs=+process.argv[3]||60;
const bin="/nix/store/4vv4mnj1qp9m4k0lgxcnxsyvdlf4i1r7-ungoogled-chromium-152.0.7977.82/bin/chromium";
const dir=mkdtempSync(tmpdir()+"/prof-");
const p=spawn(bin,["--headless=new","--no-sandbox","--remote-debugging-port=9333","--user-data-dir="+dir,"--autoplay-policy=no-user-gesture-required","about:blank"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tabs;for(let i=0;i<50;i++){try{tabs=await (await fetch("http://127.0.0.1:9333/json")).json();if(tabs.find(t=>t.type==="page"))break;}catch{}await sleep(200);}
const ws=new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);
await new Promise(r=>ws.onopen=r);
let id=0;const pend=new Map();const errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
 else if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.text+" "+(m.params.exceptionDetails.exception?.description||""));
 else if(m.method==="Runtime.consoleAPICalled"&&m.params.type==="error")errs.push("console.error "+m.params.args.map(a=>a.value||a.description).join(" "));};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
await send("Runtime.enable");await send("Page.enable");
await send("Page.navigate",{url:"file://"+file});await sleep(1500);
const expr=`(async()=>{
 const SECS=${secs};
 const sr=48000;
 const oc=new OfflineAudioContext(2,sr*SECS,sr);
 const counts={};let total=0;
 for(const k of ["createOscillator","createGain","createBiquadFilter","createWaveShaper","createBufferSource","createDynamicsCompressor","createBuffer"]){
   const o=oc[k].bind(oc);oc[k]=(...a)=>{counts[k]=(counts[k]||0)+1;total++;return o(...a);};}
 ctx=oc;
 master=oc.createDynamicsCompressor();const g=oc.createGain();g.gain.value=.5;master.connect(g);g.connect(oc.destination);
 noiseBuf=oc.createBuffer(1,sr,sr);const d=noiseBuf.getChannelData(0);for(let i=0;i<d.length;i++)d[i]=Math.random()*2-1;
 for(const k in counts)counts[k]=0;total=0;
 dm.music="synth";startMusic();clearInterval(mus.timer);
 // schedule like the live pump: top up one bar at a time, from a suspend() callback at each bar start
 const stats={mx:0};
 const t0=performance.now();
 let schedMs=0;
 const topUp=()=>{const s=performance.now();while(mus.t<oc.currentTime+.4+BAR*0&&mus.t<SECS){scheduleBar(mus.bar%8,Math.max(mus.t,oc.currentTime));mus.t+=BAR;mus.bar++;}schedMs+=performance.now()-s;};
 topUp();
 const marks=[];let last=performance.now();
 for(let t=BAR;t<SECS;t+=BAR){oc.suspend(t).then(()=>{const n=performance.now();marks.push(Math.round(n-last));last=n;topUp();oc.resume();});}
 const nb0=()=>mus.bar;
 const buf=await oc.startRendering();
 const tRender=performance.now()-t0;
 const nb=mus.bar;
 let pk=0,rms=0;const ch=buf.getChannelData(0);for(let i=0;i<ch.length;i++){const a=Math.abs(ch[i]);if(a>pk)pk=a;rms+=ch[i]*ch[i];}
 return JSON.stringify({secs:SECS,bars:nb,nodesTotal:total,nodesPerBar:+(total/nb).toFixed(1),counts,msPerBarOfAudio:marks.filter((_,i)=>i%6===0||i===marks.length-1),scheduleMs:Math.round(schedMs),renderMs:Math.round(tRender),renderRatio:+(tRender/1000/SECS).toFixed(3),peak:+pk.toFixed(3),rms:+Math.sqrt(rms/ch.length).toFixed(4)});
})()`;
const r=await send("Runtime.evaluate",{expression:expr,awaitPromise:true,returnByValue:true});
console.log(r.result?.result?.value||JSON.stringify(r.result));
if(errs.length)console.log("ERRORS",errs);
ws.close();p.kill();process.exit(0);
