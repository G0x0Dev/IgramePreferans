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

test('last-card undo requires approval from BOTH other players and restores turn and hand',async()=>{
  const port=30000+randomInt(20000);
  const proc=spawn(process.execPath,['server.js'],{cwd:process.cwd(),env:{...process.env,PORT:String(port)},stdio:'ignore'});
  const peers=[];
  try{
    let up=false;
    for(let i=0;i<100;i++){
      try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){up=true;break;}}catch{}
      await delay(20);
    }
    assert.ok(up,'server started');
    for(let i=0;i<3;i++){
      const peer=new Peer(`ws://127.0.0.1:${port}/ws`);peers.push(peer);
      await peer.ready;assert.equal((await peer.request('joinTable',{name:'P'+i})).ok,true);
    }
    await until(()=>peers.every(p=>p.state?.members.length===3));
    const playerAt=seat=>peers.find(p=>p.state?.seat===seat);
    peers[0].action('start');
    await until(()=>peers.every(p=>p.state?.phase==='auction'));
    playerAt(peers[0].state.turn).action('bid',{action:'bid',value:2});
    await until(()=>peers[0].state.auction?.highSeat!==null);
    for(let n=0;n<2;n++){
      const turn=peers[0].state.turn;
      playerAt(turn).action('bid',{action:'pass'});
      await until(()=>peers[0].state.auction.passed[turn]);
    }
    await until(()=>peers[0].state.phase==='talon');
    const declarer=playerAt(peers[0].state.contract.declarer);
    declarer.action('takeTalon');
    await until(()=>peers[0].state.phase==='discard');
    declarer.action('discard',{cards:declarer.state.hands.slice(0,2)});
    await until(()=>peers[0].state.phase==='contract');
    declarer.action('declare',{value:5});
    await until(()=>peers[0].state.phase==='following');
    for(let n=0;n<2;n++){
      playerAt(peers[0].state.turn).action('follow',{choice:'dodjem'});
      await until(()=>peers[0].state.phase==='doubles'||peers[0].state.follows.filter(Boolean).length===2);
    }
    await until(()=>peers[0].state.phase==='doubles');
    for(let n=0;n<2;n++){
      const turn=peers[0].state.turn;
      playerAt(turn).action('double',{action:'ok'});
      await until(()=>peers[0].state.phase==='playing'||peers[0].state.turn!==turn);
    }
    await until(()=>peers[0].state.phase==='playing');
    const seat=peers[0].state.turn,author=playerAt(seat),before=[...author.state.hands];
    const card=author.state.legal[0];
    author.action('play',{card});
    await until(()=>author.state?.canUndo===true);
    assert.equal(author.state.hands.length,before.length-1);
    assert.equal((await author.request('requestUndo')).ok,true);
    await until(()=>peers.every(p=>p.state?.undoRequest?.seat===seat));
    const voters=peers.filter(p=>p.state.seat!==seat);
    assert.equal((await voters[0].request('voteUndo',{approve:true})).ok,true);
    await until(()=>peers[0].state.undoRequest?.approvals[voters[0].state.seat]===true);
    assert.equal(author.state.hands.includes(card),false,'first approval does not undo');
    assert.equal((await voters[1].request('voteUndo',{approve:true})).ok,true);
    await until(()=>peers.every(p=>p.state?.undoRequest===null));
    assert.equal(author.state.turn,seat);
    assert.deepEqual(author.state.hands,before,'hand fully restored after unanimous vote');
    assert.equal(author.state.trick.length,0,'trick state restored');
    author.action('play',{card});
    await until(()=>author.state.canUndo===true);
    assert.equal((await author.request('requestUndo')).ok,true);
    await until(()=>peers[0].state.undoRequest!==null);
    assert.equal((await voters[0].request('voteUndo',{approve:false})).ok,true);
    await until(()=>peers[0].state.undoRequest===null);
    assert.equal(author.state.hands.includes(card),false,'a reject leaves the last card played');
    assert.equal(author.state.turn!==seat,true);
  }finally{
    for(const p of peers)try{p.close();}catch{}
    proc.kill('SIGTERM');
  }
});

test('solo computer table is isolated from the friends room, reconnects, and can restart',async()=>{
  const port=30000+randomInt(20000);
  const server=spawn(process.execPath,['server.js'],{
    cwd:process.cwd(),env:{...process.env,PORT:String(port),BOT_DELAY_MS:'0'},stdio:'ignore'
  });
  const peers=[];
  try{
    let online=false;
    for(let i=0;i<100;i++){
      try{if((await fetch(`http://127.0.0.1:${port}/health`)).ok){online=true;break;}}catch{}
      await delay(20);
    }
    assert.ok(online,'server starts');
    const friend=new Peer(`ws://127.0.0.1:${port}/ws`),solo=new Peer(`ws://127.0.0.1:${port}/ws`);
    peers.push(friend,solo);
    await Promise.all([friend.ready,solo.ready]);
    const member=await friend.request('joinTable',{name:'Friend'});
    assert.equal(member.ok,true);
    const practice=await solo.request('joinSolo',{name:'Tester'});
    assert.equal(practice.ok,true);
    assert.equal(practice.seat,0);
    await until(()=>solo.state?.mode==='solo'&&friend.state?.mode==='friends');
    assert.deepEqual(solo.state.players.map(p=>p.name),['Tester','Computer 1','Computer 2']);
    assert.equal(solo.state.members.length,3);
    assert.equal(solo.state.history.length,0);
    assert.equal(solo.state.hands.length,0);
    assert.equal(friend.state.members.length,1,'solo users do not take multiplayer seats');
    solo.action('settings',{startBula:50,maxRefe:3});
    await until(()=>solo.state.settings.startBula===50&&solo.state.settings.maxRefe===3);
    solo.action('start');
    await until(()=>solo.state?.phase==='auction');
    assert.equal(solo.state.hands.length,10);
    await until(()=>solo.state.auction.history.some(p=>p.seat!==0));
    // The bots bid without a second or third WebSocket connection.
    assert.equal(friend.state.phase,'lobby');
    assert.equal(friend.state.history.length,0,'practice scores do not touch the shared season');
    const other=new Peer(`ws://127.0.0.1:${port}/ws`);peers.push(other);
    await other.ready;
    const restore=await other.request('joinSolo',{token:practice.token});
    assert.equal(restore.ok,true);
    assert.equal(restore.seat,0);
    await until(()=>other.state?.mode==='solo');
    assert.equal(other.state.hands.length,10);
    assert.equal((await other.request('restartSolo')).ok,true);
    await until(()=>other.state.phase==='lobby');
    assert.deepEqual(other.state.players.map(p=>p.name),['Tester','Computer 1','Computer 2']);
    assert.equal((await other.request('exitSolo')).ok,true);
    assert.equal((await other.request('joinTable',{name:'Tester'})).ok,true);
    await until(()=>friend.state.members.length===2);
    assert.equal(friend.state.phase,'lobby');
  }finally{
    peers.forEach(p=>{try{p.close();}catch{}});
    server.kill('SIGTERM');
  }
});
