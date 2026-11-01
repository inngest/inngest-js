// Throwaway. node bench-moments.mjs /abs/path/index.html before|after [secs] : Doom mode with a moment every second; prints main-thread and audio numbers.
// Edit `bin` to your Chromium. Run it through /tmp/claude-1000/heavy on a shared machine.
import {spawn} from "node:child_process";import {mkdtempSync} from "node:fs";import {tmpdir} from "node:os";
const file=process.argv[2],mode=process.argv[3]||"after",secs=+process.argv[4]||60;
const bin="/nix/store/4vv4mnj1qp9m4k0lgxcnxsyvdlf4i1r7-ungoogled-chromium-152.0.7977.82/bin/chromium";
const port=9400+Math.floor(Math.random()*500);
const dir=mkdtempSync(tmpdir()+"/prof-");
const p=spawn(bin,["--headless=new","--no-sandbox","--remote-debugging-port="+port,"--user-data-dir="+dir,"--autoplay-policy=no-user-gesture-required","about:blank"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tabs;for(let i=0;i<80;i++){try{tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json();if(tabs.find(t=>t.type==="page"))break;}catch{}await sleep(200);}
const ws=new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pend=new Map();const errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
 else if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.text+" "+(m.params.exceptionDetails.exception?.description||""));
 else if(m.method==="Runtime.consoleAPICalled"&&["error","warning"].includes(m.params.type))errs.push(m.params.type+" "+m.params.args.map(a=>a.value||a.description).join(" "));};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)errs.push("eval "+JSON.stringify(r.result.exceptionDetails).slice(0,400));return r.result?.result?.value;};
await send("Runtime.enable");await send("Page.enable");
await send("Page.navigate",{url:"file://"+file});await sleep(1500);
await ev(`window.__lt=[];new PerformanceObserver(l=>l.getEntries().forEach(e=>__lt.push(Math.round(e.duration)))).observe({entryTypes:["longtask"]});`);
await ev("document.querySelector('#speaker').click()");await sleep(300);
await ev(`(()=>{window.__nodes={};for(const k of ["createOscillator","createGain","createBiquadFilter","createWaveShaper","createBufferSource","createDynamicsCompressor"]){const f=ctx[k].bind(ctx);ctx[k]=(...a)=>{__nodes[k]=(__nodes[k]||0)+1;return f(...a);};}})()`);
await ev(mode==="before"?'dm.music="freedoom";__sound.setStyle("doom")':`__sound.dmSetTrack(${process.argv[5]||3});__sound.setStyle("doom")`);
await sleep(2500);
const out={mode,secs};
out.start=await ev("JSON.stringify({music:__sound.music(),baseLatency:ctx.baseLatency,outputLatency:ctx.outputLatency,state:ctx.state,sr:ctx.sampleRate,hasStats:!!ctx.playoutStats})");
await ev("window.__nodes={};window.__lt.length=0;window.__t=[];ctx.playoutStats&&ctx.playoutStats.resetLatency&&ctx.playoutStats.resetLatency()");
const ids=await ev("MOMENTS.map(m=>m.id).filter(x=>x!=='enable'&&x!=='disable'&&x!=='key')");
const t0=Date.now();
for(let i=0;i<secs;i++){
 const mid=ids[i%ids.length];
 await ev(`(()=>{const a=performance.now();__sound.play("${mid}");__t.push([ "${mid}",+(performance.now()-a).toFixed(2)]);})()`);
 // keep health healthy so game over does not mute moments
 await ev("__sound.dm.hp<40&&__sound.dm.over===false&&(dm.hp=100)");
 await sleep(Math.max(0,(i+1)*1000-(Date.now()-t0)));
}
out.nodesCreatedIn60s=await ev("JSON.stringify(__nodes)");
out.longTasksMs=await ev("JSON.stringify(__lt)");
const t=JSON.parse(await ev("JSON.stringify(__t)"));
out.playSyncMs={max:Math.max(...t.map(x=>x[1])),mean:+(t.reduce((a,x)=>a+x[1],0)/t.length).toFixed(2),perMoment:Object.fromEntries(t.slice(0,ids.length).map(x=>x))};
out.playout=await ev("ctx.playoutStats?JSON.stringify({underrunEvents:ctx.playoutStats.fallbackFramesEvents,fallbackFrames:ctx.playoutStats.fallbackFramesDuration,totalFrames:ctx.playoutStats.totalFramesDuration,avgLatency:ctx.playoutStats.averageLatency,maxLatency:ctx.playoutStats.maximumLatency}):'n/a'");
out.ctxTime=await ev("+ctx.currentTime.toFixed(1)");
out.errors=errs;
// audio-thread proxy: 60 s offline render of the music buffer plus the same moment each second
out.offline=await ev(`(async()=>{
 const SECS=${secs},sr=ctx.sampleRate,oc=new OfflineAudioContext(2,sr*SECS,sr);
 const music=${mode==="before"?"loopBuf":"await trackBuffer(TRACKS[__sound.dm.track])"};
 const real={ctx,master};
 const comp=oc.createDynamicsCompressor(),g=oc.createGain();g.gain.value=.5;comp.connect(g);g.connect(oc.destination);
 const bus=oc.createGain();bus.gain.value=.55;bus.connect(comp);const src=oc.createBufferSource();src.buffer=music;src.loop=true;src.connect(bus);src.start();
 let nodes=0;for(const k of ["createOscillator","createGain","createBiquadFilter","createWaveShaper","createBufferSource"]){const f=oc[k].bind(oc);oc[k]=(...a)=>{nodes++;return f(...a);};}
 const ids=MOMENTS.map(m=>m.id).filter(x=>x!=='enable'&&x!=='disable'&&x!=='key');
 const fire=i=>{ctx=oc;master=comp;try{STYLES.doom[ids[i%ids.length]](GAIN[MOMENTS.find(m=>m.id===ids[i%ids.length]).tier]);}finally{ctx=real.ctx;master=real.master;}};
 fire(0);
 for(let k=1;k<SECS;k++)oc.suspend(k).then(()=>{fire(k);oc.resume();});
 const t0=performance.now();await oc.startRendering();const ms=performance.now()-t0;
 return JSON.stringify({renderMs:Math.round(ms),ratio:+(ms/1000/SECS).toFixed(3),nodesFromMoments:nodes});
})()`);
console.log(JSON.stringify(out,null,1));
ws.close();p.kill();process.exit(0);
