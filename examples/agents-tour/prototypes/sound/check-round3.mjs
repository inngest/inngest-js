// Throwaway. node check-round3.mjs /abs/path/index.html : round 3 features over CDP. Edit `bin` to your Chromium; run through /tmp/claude-1000/heavy.
import {spawn} from "node:child_process";import {mkdtempSync} from "node:fs";import {tmpdir} from "node:os";
const file=process.argv[2];
const bin="/nix/store/4vv4mnj1qp9m4k0lgxcnxsyvdlf4i1r7-ungoogled-chromium-152.0.7977.82/bin/chromium";
const port=9400+Math.floor(Math.random()*500),dir=mkdtempSync(tmpdir()+"/prof-");
const p=spawn(bin,["--headless=new","--no-sandbox","--remote-debugging-port="+port,"--user-data-dir="+dir,"--autoplay-policy=no-user-gesture-required","--window-size=1280,800","about:blank"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tabs;for(let i=0;i<80;i++){try{tabs=await (await fetch(`http://127.0.0.1:${port}/json`)).json();if(tabs.find(t=>t.type==="page"))break;}catch{}await sleep(200);}
const ws=new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pend=new Map();const errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
 else if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.text+" "+(m.params.exceptionDetails.exception?.description||""));
 else if(m.method==="Runtime.consoleAPICalled"&&["error","warning"].includes(m.params.type))errs.push(m.params.type+" "+m.params.args.map(a=>a.value||a.description).join(" "));};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)errs.push("eval "+JSON.stringify(r.result.exceptionDetails).slice(0,400));return r.result?.result?.value;};
const key=async(k,shift)=>{for(const t of ["keyDown","keyUp"])await send("Input.dispatchKeyEvent",{type:t,key:k,text:t==="keyDown"?k:undefined,modifiers:shift?8:0,code:k.length===1?"Key"+k.toUpperCase():k,windowsVirtualKeyCode:k.length===1?k.toUpperCase().charCodeAt(0):0});};
await send("Runtime.enable");await send("Page.enable");
await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
await send("Page.navigate",{url:"file://"+file});await sleep(1200);
const out={};
out.mutedOnLoad=await ev("JSON.stringify({muted:__sound.st.muted,music:__sound.music()})");
// pick Doom while muted via the menu: unmutes and starts
await key("M",true);await sleep(150);
await ev("document.querySelector('[data-style=doom]').click()");await sleep(2500);
out.pickWhileMuted=await ev("JSON.stringify({muted:__sound.st.muted,style:__sound.st.style,music:__sound.music(),bar:document.querySelector('#dbar').classList.contains('on'),track:__sound.TRACKS[__sound.dm.track].id})");
out.synth1Buf=await ev("(async()=>{const b=await __sound.bufs.synth1;return JSON.stringify({sec:+b.duration.toFixed(3),rms:b.__rms,render:b.__render})})()");
// every track: switch, check it plays from a buffer
out.tracks=[];
for(let i=0;i<7;i++){await ev(`__sound.dmSetTrack(${i})`);await sleep(400);
 out.tracks.push(await ev(`(async()=>{const t=__sound.TRACKS[${i}],b=await __sound.trackBuffer(t);return JSON.stringify({id:t.id,name:t.name,sec:+b.duration.toFixed(3),ch:b.numberOfChannels,rms:b.__rms,ms:b.__ms,render:b.__render,looping:mus.src&&mus.src.loop,label:document.querySelector('#dtname').textContent,btn:document.querySelector('#dtrack').textContent})})()`));}
// keys: v cycles, Shift+V opens list, digits pick, Esc closes
await ev("__sound.dmSetTrack(0)");await key("v");await sleep(300);out.afterV=await ev("__sound.dm.track");
await key("V",true);await sleep(150);out.listOpen=await ev("!document.querySelector('#tracklist').hidden");
await key("4");await sleep(300);out.afterListPick4=await ev("JSON.stringify({track:__sound.dm.track,listOpen:!document.querySelector('#tracklist').hidden,hp:__sound.dm.hp})");
await key("V",true);await sleep(100);await key("Escape");await sleep(100);out.escClosed=await ev("document.querySelector('#tracklist').hidden");
out.remembered=await ev("sessionStorage.getItem('doomTrack')");
// mute then pick another style while muted -> unmute; also peek
await key("m");await sleep(300);
out.mutedDoom=await ev("JSON.stringify({muted:__sound.st.muted,music:__sound.music(),bar:document.querySelector('#dbar').classList.contains('on')})");
await key("M",true);await sleep(150);await ev("document.querySelector('[data-style=quest]').click()");await sleep(400);
out.pickQuestWhileMuted=await ev("JSON.stringify({muted:__sound.st.muted,style:__sound.st.style,music:__sound.music()})");
await ev("__sound.setStyle('doom')");await key("m");await sleep(300);
out.peekSchedule=await ev("JSON.stringify({muted:__sound.st.muted,style:__sound.st.style,timer:peekT!==null})");
const edges={};
for(let i=0;i<12;i++){await ev("lastKeyAt=-1e9");await key("E",true);await sleep(80);const e=await ev("JSON.stringify({edge:peekEl.dataset.edge,vis:peekEl.style.visibility,busy:peekBusy,rect:(r=>[r.x|0,r.y|0,r.width|0,r.height|0])(peekEl.getBoundingClientRect())})");if(!e){out.peekErr=errs.slice(-3);break;}const o=JSON.parse(e);edges[o.edge]=(edges[o.edge]||0)+1;if(i===0)out.peekFirst=e;
 await sleep(2700);}
out.peekEdges=edges;
out.peekAfter=await ev("JSON.stringify({vis:peekEl.style.visibility,busy:peekBusy})");
// reduced motion: no peek
await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
out.peekReduced=await ev("peekShow()");
out.errors=errs;
console.log(JSON.stringify(out,null,1));
ws.close();p.kill();process.exit(0);
