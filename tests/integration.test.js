import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomInt } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

class Peer {
  constructor(url){
    this.ws=new WebSocket(url);
    this.pending=new Map();this.nextId=0;this.state=null;this.errors=[];
    this.ready=new Promise((resolve,reject)=>{this.ws.onopen=resolve;this.ws.onerror=reject;});
    this.ws.onmessage=({data})=>{
      const msg=JSON.parse(data);
      if(msg.event==='ack'){
        const cb=this.pending.get(msg.data.id);
        this.pending.delete(msg.data.id);
        cb?.(msg.data.result);
      }else if(msg.event==='state')this.state=msg.data;
      else if(msg.event==='actionError')this.errors.push(msg.data);
    };
  }
  request(event,data={}){
    const id=++this.nextId;
    return new Promise(resolve=>{this.pending.set(id,resolve);this.ws.send(JSON.stringify({event,data,id}));});
  }
  action(event,data={}){this.ws.send(JSON.stringify({event,data,id:++this.nextId}));}
  close(){this.ws.close();}
}
async function until(fn,maxMs=2200){
  const start=Date.now();
  while(!fn()){
    if(Date.now()-start>maxMs)throw Error('Timed out waiting for multiplayer state.');
    await delay(12);
  }
}

test('real HTTP + three WebSocket clients + reconnection + private hands + bid + following + scoring',async()=>{
  const port=30_000+randomInt(20_000);
  const proc=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port)},stdio:'ignore'});
  const peers=[];
  try{
    await until(async()=>true); // short event-loop yield before health polling
    let up=false;
    for(let i=0;i<100;i++){
      try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){up=true;break;}}
      catch{}await delay(20);
    }
    assert.ok(up,'server started');
    const html=await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(html.status,200);
    assert.match(await html.text(),/Preferans/);
    for(let i=0;i<3;i++){
      const peer=new Peer(`ws://127.0.0.1:${port}/ws`);peers.push(peer);
      await peer.ready;
    }
    const host=await peers[0].request('createRoom',{name:'Host'});
    assert.equal(host.ok,true);
    const one=await peers[1].request('joinRoom',{code:host.code,name:'Guest1'});
    const two=await peers[2].request('joinRoom',{code:host.code,name:'Guest2'});
    assert.equal(one.seat,1);assert.equal(two.seat,2);
    peers[0].action('start');
    await until(()=>peers.every(p=>p.state?.phase==='auction'));
    assert.deepEqual(peers.map(p=>p.state.hands.length),[10,10,10]);
    assert.ok(peers[0].state.hands.some(c=>!peers[1].state.hands.includes(c)));
    assert.equal(peers[0].state.talon.length,0);
    const bidder=peers[peers[0].state.turn];
    bidder.action('bid',{action:'bid',value:5});
    await until(()=>peers[0].state.auction.bid===5);
    for(let n=0;n<2;n++){
      const turn=peers[0].state.turn;
      peers[turn].action('bid',{action:'pass'});
      await until(()=>peers[0].state.auction.passed[turn]);
    }
    await until(()=>peers.every(p=>p.state.phase==='talon'));
    assert.equal(peers[0].state.talon.length,2); // exposed talon
    const dec=peers[0].state.contract.declarer;
    peers[dec].action('takeTalon');
    await until(()=>peers[0].state.phase==='discard');
    assert.equal(peers[dec].state.hands.length,12);
    assert.equal(peers[(dec+1)%3].state.hands.length,10);
    peers[dec].action('discard',{cards:peers[dec].state.hands.slice(0,2)});
    await until(()=>peers[0].state.phase==='contract');
    peers[dec].action('declare',{value:5});
    await until(()=>peers[0].state.phase==='following');
    peers[peers[0].state.turn].action('follow',{choice:'ne'});
    await until(()=>peers[0].state.follows.filter(x=>x===false).length===1);
    peers[peers[0].state.turn].action('follow',{choice:'ne-bi'});
    await until(()=>peers.every(p=>p.state.phase==='summary'));
    assert.deepEqual(peers[0].state.followMessages.filter(Boolean).sort(),['Ne','Ne bi']);
    assert.equal(peers[0].state.tricks[dec],10);
    assert.equal(peers[0].state.scores.bula[dec],90);
    // Reconnect with the exact session token, even once the game is underway.
    const old=peers[1];old.close();
    const reconnect=new Peer(`ws://127.0.0.1:${port}/ws`);peers.push(reconnect);
    await reconnect.ready;
    const restored=await reconnect.request('joinRoom',{code:one.code,token:one.token});
    assert.equal(restored.ok,true);assert.equal(restored.seat,1);
    await until(()=>reconnect.state?.phase==='summary');
    assert.equal(reconnect.state.hands.length,10);
  }finally{
    peers.forEach(p=>{try{p.close();}catch{}});
    proc.kill('SIGTERM');
  }
});
