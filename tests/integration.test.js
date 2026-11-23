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

test('one shared table: five friends, settings, private hands and reconnection',async()=>{
  const port=30_000+randomInt(20_000);
  const proc=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port)},stdio:'ignore'});
  const peers=[];
  try{
    let up=false;
    for(let i=0;i<100;i++){
      try{const r=await fetch(`http://127.0.0.1:${port}/health`);if(r.ok){up=true;break;}}
      catch{}await delay(20);
    }
    assert.ok(up,'server started');
    const html=await fetch(`http://127.0.0.1:${port}/`);
    assert.equal(html.status,200);
    assert.match(await html.text(),/Preferans/);
    const joined=[];
    for(let i=0;i<6;i++){
      const peer=new Peer(`ws://127.0.0.1:${port}/ws`);peers.push(peer);
      await peer.ready;
      joined.push(await peer.request('joinTable',{name:'Friend'+i}));
    }
    assert.deepEqual(joined.slice(0,5).map(r=>r.seat),[0,1,2,null,null]);
    assert.ok(joined.slice(0,5).every(r=>r.ok && r.code==='FRIENDS'));
    assert.equal(joined[5].ok,false);
    assert.match(joined[5].error,/five friend spots/i);
    await until(()=>peers[4].state?.members.length===5);
    assert.ok(peers[4].state.members.every(m=>!('token' in m)));
    peers[4].action('settings',{startBula:50,maxRefe:4});
    await until(()=>peers[4].errors.length>0);
    assert.deepEqual(peers[4].state.settings,{startBula:100,maxRefe:2});
    assert.equal((await peers[1].request('sitOut')).ok,true);
    await until(()=>peers[1].state.seat===null);
    assert.equal((await peers[3].request('takeSeat')).ok,true);
    await until(()=>peers[3].state.seat===1);
    peers[3].action('settings',{startBula:60,maxRefe:3});
    await until(()=>peers[0].state?.settings.startBula===60 && peers[0].state?.settings.maxRefe===3);
    peers[0].action('start');
    await until(()=>peers.slice(0,5).every(p=>p.state?.phase==='auction'));
    assert.deepEqual(peers.slice(0,5).map(p=>p.state.hands.length),[10,0,10,10,0]);
    assert.ok(peers[0].state.hands.some(c=>!peers[3].state.hands.includes(c)));
    assert.deepEqual(peers[4].state.hands,[]);
    const activeAt=seat=>peers.find(p=>p.state?.seat===seat);
    activeAt(peers[0].state.turn).action('bid',{action:'bid',value:2});
    await until(()=>peers[0].state.auction.bid===2);
    for(let n=0;n<2;n++){
      const turn=peers[0].state.turn;
      activeAt(turn).action('bid',{action:'pass'});
      await until(()=>peers[0].state.auction.passed[turn]);
    }
    await until(()=>peers.slice(0,5).every(p=>p.state.phase==='talon'));
    const dec=peers[0].state.contract.declarer;
    const declarer=activeAt(dec);
    declarer.action('takeTalon');
    await until(()=>peers[0].state.phase==='discard');
    assert.equal(declarer.state.hands.length,12);
    assert.deepEqual(peers[4].state.hands,[]);
    declarer.action('discard',{cards:declarer.state.hands.slice(0,2)});
    await until(()=>peers[0].state.phase==='contract');
    declarer.action('declare',{value:5});
    await until(()=>peers[0].state.phase==='following');
    activeAt(peers[0].state.turn).action('follow',{choice:'ne'});
    await until(()=>peers[0].state.follows.filter(x=>x===false).length===1);
    activeAt(peers[0].state.turn).action('follow',{choice:'ne-bi'});
    await until(()=>peers.slice(0,5).every(p=>p.state.phase==='summary'));
    assert.deepEqual(peers[4].state.followMessages.filter(Boolean).sort(),['Ne','Ne bi']);
    assert.equal(peers[0].state.tricks[dec],10);
    assert.equal(peers[0].state.scores.bula[dec],50);
    const reconnect=new Peer(`ws://127.0.0.1:${port}/ws`);peers.push(reconnect);
    await reconnect.ready;
    const restored=await reconnect.request('joinTable',{token:joined[3].token});
    assert.equal(restored.ok,true);assert.equal(restored.seat,1);
    await until(()=>reconnect.state?.phase==='summary');
    assert.equal(reconnect.state.hands.length,10);
    assert.equal((await fetch(`http://127.0.0.1:${port}/health`).then(r=>r.json())).rooms,1);
  }finally{
    peers.forEach(p=>{try{p.close();}catch{}});
    proc.kill('SIGTERM');
  }
});
