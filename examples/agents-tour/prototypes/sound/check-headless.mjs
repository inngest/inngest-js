// Throwaway. node check-headless.mjs /abs/path/index.html /abs/shots/dir : drives the page over CDP and prints what happened. Edit `bin` to your Chromium.
import {spawn} from "node:child_process";import {mkdtempSync,writeFileSync} from "node:fs";
const file=process.argv[2],shots=process.argv[3];
const bin="/nix/store/4vv4mnj1qp9m4k0lgxcnxsyvdlf4i1r7-ungoogled-chromium-152.0.7977.82/bin/chromium";
const dir=mkdtempSync(tmpdir()+"/prof-");
const p=spawn(bin,["--headless=new","--no-sandbox","--remote-debugging-port=9334","--user-data-dir="+dir,"--autoplay-policy=no-user-gesture-required","--window-size=1280,800","about:blank"],{stdio:"ignore"});
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
let tabs;for(let i=0;i<50;i++){try{tabs=await (await fetch("http://127.0.0.1:9334/json")).json();if(tabs.find(t=>t.type==="page"))break;}catch{}await sleep(200);}
const ws=new WebSocket(tabs.find(t=>t.type==="page").webSocketDebuggerUrl);await new Promise(r=>ws.onopen=r);
let id=0;const pend=new Map();const errs=[];
ws.onmessage=e=>{const m=JSON.parse(e.data);if(m.id&&pend.has(m.id)){pend.get(m.id)(m);pend.delete(m.id);}
 else if(m.method==="Runtime.exceptionThrown")errs.push(m.params.exceptionDetails.text+" "+(m.params.exceptionDetails.exception?.description||""));
 else if(m.method==="Runtime.consoleAPICalled"&&["error","warning"].includes(m.params.type))errs.push(m.params.type+" "+m.params.args.map(a=>a.value||a.description).join(" "));
 else if(m.method==="Log.entryAdded"&&m.params.entry.level==="error")errs.push("log "+m.params.entry.text+" "+(m.params.entry.url||""));};
const send=(method,params={})=>new Promise(r=>{const i=++id;pend.set(i,r);ws.send(JSON.stringify({id:i,method,params}));});
const ev=async x=>{const r=await send("Runtime.evaluate",{expression:x,awaitPromise:true,returnByValue:true});if(r.result?.exceptionDetails)errs.push("eval "+JSON.stringify(r.result.exceptionDetails).slice(0,300));return r.result?.result?.value;};
const shot=async n=>{const r=await send("Page.captureScreenshot",{format:"png"});writeFileSync(shots+"/"+n+".png",Buffer.from(r.result.data,"base64"));};
const key=async k=>{for(const t of ["keyDown","keyUp"])await send("Input.dispatchKeyEvent",{type:t,key:k,text:t==="keyDown"?k:undefined,code:k.length===1?"Key"+k.toUpperCase():k,windowsVirtualKeyCode:k.length===1?k.toUpperCase().charCodeAt(0):0});};
await send("Runtime.enable");await send("Page.enable");await send("Log.enable");
await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-color-scheme",value:"dark"}]});
await send("Page.navigate",{url:"file://"+file});await sleep(1200);
const out={};
out.mutedOnLoad=await ev("JSON.stringify({muted:__sound.st.muted,music:__sound.music(),bar:document.querySelector('#dbar').classList.contains('on')})");
await ev("document.querySelector('#speaker').click()");await sleep(300);
const styles=await ev("Object.keys(STYLES)");
const moments=await ev("MOMENTS.map(m=>m.id)");
let n=0;
for(const s of styles){await ev(`__sound.setStyle("${s}")`);for(const m of moments){await ev(`__sound.play("${m}")`);n++;}await sleep(30);}
out.momentsPlayed=n+" ("+styles.length+" styles x "+moments.length+")";
await ev('__sound.setStyle("soft")');await sleep(200);
// doom, freedoom music
await ev('__sound.setStyle("doom")');await sleep(1200);
out.doomFreedoom=await ev("JSON.stringify({music:__sound.music(),src:!!mus.src,loopSec:loopBuf&&+loopBuf.duration.toFixed(3),ch:loopBuf&&loopBuf.numberOfChannels,sr:loopBuf&&loopBuf.sampleRate,loop:mus.src&&mus.src.loop,face:document.querySelector('#face').dataset.k,faceNat:[document.querySelector('#face').naturalWidth,document.querySelector('#face').naturalHeight],creditVisible:getComputedStyle(document.querySelector('#credit')).visibility,creditHref:document.querySelector('#credit').getAttribute('href')})");
await shot("fd-1-full");
for(const [k,name] of [["1","90"],["2","70"],["3","50"],["4","30"],["5","10"]]){await key(k);await sleep(450);out["face"+name]=await ev("document.querySelector('#face').dataset.k+' hp '+dm.hp");await shot("fd-face-"+name);}
await key("6");await sleep(300);out.gameover=await ev("document.querySelector('#face').dataset.k+' hp '+dm.hp+' over '+dm.over");await shot("fd-gameover");await sleep(1700);out.afterOver=await ev("'hp '+dm.hp+' over '+dm.over+' face '+document.querySelector('#face').dataset.k");
// moods
for(const m of ["checkPass","runFail","run"]){await ev(`__sound.play("${m}")`);await sleep(40);out["mood_"+m]=await ev("document.querySelector('#face').dataset.k");await sleep(1100);}
// mute instantly
await key("m");await sleep(300);out.afterMute=await ev("JSON.stringify({music:__sound.music(),bar:document.querySelector('#dbar').classList.contains('on')})");
await key("m");await sleep(500);out.afterUnmute=await ev("JSON.stringify({music:__sound.music(),bar:document.querySelector('#dbar').classList.contains('on')})");
// synth toggle
await key("v");await sleep(900);out.synth=await ev("JSON.stringify({music:__sound.music(),mode:dm.music,gtr:!!mus.gtr,btn:document.querySelector('#dmusic').textContent})");
await key("v");await sleep(900);out.backToFreedoom=await ev("JSON.stringify({music:__sound.music(),mode:dm.music,src:!!mus.src})");
await ev('__sound.setStyle("soft")');await sleep(300);out.leave=await ev("JSON.stringify({music:__sound.music(),bar:document.querySelector('#dbar').classList.contains('on')})");
// reduced motion
await send("Emulation.setEmulatedMedia",{features:[{name:"prefers-reduced-motion",value:"reduce"}]});
out.reduce=await ev("matchMedia('(prefers-reduced-motion: reduce)').matches");
out.errors=errs;
console.log(JSON.stringify(out,null,1));
ws.close();p.kill();process.exit(0);
