/** Standalone HTTP + WebSocket host: requires only Node.js >=20. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createGame,deal,auctionAction,takeTalon,discard,declare,follow,callPartner,doubleAction,playCard,advanceTrick,viewFor,finalScores } from './game.js';
import { loadHistory,saveHistory,mergeHistory,leaderboard } from './history.js';

const publicDir=join(dirname(fileURLToPath(import.meta.url)),'public');
const staticPaths=new Map([
  ['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css']
]);
const mime={'index.html':'text/html; charset=utf-8','app.js':'application/javascript; charset=utf-8','styles.css':'text/css; charset=utf-8'};
const clients=new Map();
const ROOM_CODE='FRIENDS';
const FRIEND_LIMIT=5;
const room={code:ROOM_CODE,game:createGame(),members:[],nextMemberId:1,updated:Date.now(),timer:null,archiveTimer:null,history:loadHistory(),undoCandidate:null,undoRequest:null,matchId:null};
const MAX_MESSAGE=24_000;
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let socketCounter=0;
const nameValid=v=>typeof v==='string'&&v.trim().length>=1&&v.trim().length<=24;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({status:'ok',rooms:1}));return;
  }
  const file=staticPaths.get(url.pathname);
  if(req.method!=='GET'||!file){res.writeHead(404);res.end('Not found');return;}
  try{
    const bytes=await readFile(join(publicDir,file));
    res.writeHead(200,{
      'Content-Type':mime[file],
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin',
      'Cache-Control':'no-store'
    });res.end(bytes);
  }catch{res.writeHead(500);res.end('Unable to serve site');}
});
function frame(data,opcode=1){
  const payload=Buffer.isBuffer(data)?data:Buffer.from(data);
  let header;
  if(payload.length<126){header=Buffer.from([128|opcode,payload.length]);}
  else if(payload.length<65536){header=Buffer.alloc(4);header[0]=128|opcode;header[1]=126;header.writeUInt16BE(payload.length,2);}
  else{header=Buffer.alloc(10);header[0]=128|opcode;header[1]=127;header.writeBigUInt64BE(BigInt(payload.length),2);}
  return Buffer.concat([header,payload]);
}
function send(client,event,data){
  if(!client||client.closed||!client.socket.writable)return;
  client.socket.write(frame(JSON.stringify({event,data})));
}
function reply(client,id,data){
  if(Number.isSafeInteger(id)&&id>=0) send(client,'ack',{id,result:data});
}
function sendState(room){
  room.updated=Date.now();
  const members=room.members.map(m=>({id:m.id,name:m.name,online:m.online,seat:m.seat}));
  for(const member of room.members){
    const view=viewFor(room.game,member.seat,room.code);
    view.members=members;
    view.memberId=member.id;
    view.myName=member.name;
    view.friendLimit=FRIEND_LIMIT;
    view.history=room.history;
    view.leaderboard=leaderboard(room.history);
    view.undoRequest=room.undoRequest ? {seat:room.undoRequest.seat,card:room.undoRequest.card,approvals:room.undoRequest.approvals} : null;
    view.canUndo=!!room.undoCandidate && !room.undoRequest && room.undoCandidate.seat===member.seat && Date.now()-room.undoCandidate.at<=30000 && ['playing','trickReview','summary'].includes(room.game.phase);
    for(const cid of member.connections)send(clients.get(cid),'state',view);
  }
}
function detach(client){
  const {room,member}=client;
  if(!room||!member)return;
  member.connections.delete(client.id);
  member.online=member.connections.size>0;
  client.room=null;client.seat=null;client.member=null;client.token=null;
  sendState(room);
}
function attach(client,room,member){
  if(client.room)detach(client);
  client.room=room;client.member=member;client.seat=member.seat;client.token=member.token;
  member.connections.add(client.id);member.online=true;
}
function session(client){
  const {room,member,token}=client;
  if(!room||!member||!room.members.includes(member)||member.token!==token)throw Error('Session expired. Please rejoin.');
  return {room,seat:member.seat,member};
}
function removeMember(room,member){
  if(member.seat!==null)room.game.players[member.seat]=null;
  room.members=room.members.filter(m=>m!==member);
  for(const id of [...member.connections]){
    const connection=clients.get(id);
    if(!connection)continue;
    connection.room=null;connection.member=null;connection.seat=null;connection.token=null;
    send(connection,'leftTable',{});
  }
  member.connections.clear();member.online=false;member.seat=null;
}
function guard(client,event,fn){
  try{
    const {room,seat}=session(client);
    if(seat===null)throw Error('You are waiting. Choose a seat before playing.');
    if(room.undoRequest)throw Error('An undo request is awaiting both opponents.');
    fn(room.game,seat,room);
    room.updated=Date.now();
    if(process.env.DEBUG_GAME)console.log(room.code,seat,event,room.game.phase);
    sendState(room);
  }catch(e){send(client,'actionError',e.message||'Invalid action.');}
}
function settleReview(room){
  if(room.timer)clearTimeout(room.timer);
  room.timer=setTimeout(()=>{
    room.timer=null;
    if(room.game.phase==='trickReview'){
      try{advanceTrick(room.game);if(room.game.finished)scheduleArchive(room);sendState(room);}catch(e){console.error(e);}
    }
  },1400);
}
const UNDO_WINDOW_MS=30000;
function captureGame(g){
  return structuredClone({...g,players:[null,null,null]});
}
function restoreGame(room,snapshot){
  const players=room.game.players;
  room.game={...structuredClone(snapshot),players};
}
function clearArchiveTimer(room){
  if(room.archiveTimer)clearTimeout(room.archiveTimer);
  room.archiveTimer=null;
}
function recordFinished(room){
  if(!room.game.finished || !room.matchId || room.history.some(h=>h.id===room.matchId))return;
  const record={
    id:room.matchId,at:new Date().toISOString(),rounds:room.game.round,
    players:room.game.players.map((p,i)=>({name:p.name,score:finalScores(room.game)[i]}))
  };
  room.history=mergeHistory(room.history,[record]);
  saveHistory(room.history);
  sendState(room);
}
function scheduleArchive(room){
  if(!room.game.finished || room.archiveTimer)return;
  clearArchiveTimer(room);
  const remaining=room.undoCandidate ? Math.max(0,UNDO_WINDOW_MS-(Date.now()-room.undoCandidate.at)) : 0;
  room.archiveTimer=setTimeout(()=>{
    room.archiveTimer=null;
    if(room.game.finished && !room.undoRequest)recordFinished(room);
  },remaining+50);
  room.archiveTimer.unref?.();
}
function resetUndo(room){
  room.undoRequest=null;
  room.undoCandidate=null;
  clearArchiveTimer(room);
}
function handleUndo(client,event,data,id){
  try{
    const {seat}=session(client);
    if(seat===null)throw Error('Only seated players can request or approve an undo.');
    const candidate=room.undoCandidate;
    if(event==='requestUndo'){
      if(room.undoRequest)throw Error('An undo request is already pending.');
      if(!candidate || candidate.seat!==seat)throw Error('You can only undo the card you played last.');
      if(Date.now()-candidate.at>UNDO_WINDOW_MS)throw Error('Undo time expired (30 seconds).');
      if(!['playing','trickReview','summary'].includes(room.game.phase))throw Error('The card can no longer be undone.');
      const responders=[0,1,2].filter(i=>i!==seat);
      if(responders.some(i=>!room.game.players[i]?.online))
        throw Error('Both other seated players must be online to approve.');
      if(room.timer){clearTimeout(room.timer);room.timer=null;}
      clearArchiveTimer(room);
      room.undoRequest={seat,card:candidate.card,approvals:[false,false,false],started:Date.now()};
      room.undoRequest.approvals[seat]=true;
      room.undoRequest.timer=setTimeout(()=>{
        if(room.undoRequest){room.undoRequest=null; if(room.game.phase==='trickReview')settleReview(room);if(room.game.finished)scheduleArchive(room);sendState(room);}
      },20000);
      room.undoRequest.timer.unref?.();
    }else if(event==='voteUndo'){
      const pending=room.undoRequest;
      if(!pending)throw Error('There is no undo request.');
      if(seat===pending.seat)throw Error('Only the other two players can vote.');
      if(typeof data.approve!=='boolean')throw Error('Choose approve or reject.');
      if(pending.approvals[seat]!==false)throw Error('You already voted.');
      if(!data.approve){
        clearTimeout(pending.timer);
        room.undoRequest=null;
        if(room.game.phase==='trickReview')settleReview(room);
        if(room.game.finished)scheduleArchive(room);
      }else{
        pending.approvals[seat]=true;
        if(pending.approvals.every(Boolean)){
          clearTimeout(pending.timer);
          clearArchiveTimer(room);
          restoreGame(room,room.undoCandidate.snapshot);
          room.undoRequest=null;room.undoCandidate=null;
          room.game.log.push(`All three players approved undo. ${room.game.players[pending.seat].name} can replay the card.`);
          if(room.game.log.length>90)room.game.log.shift();
        }
      }
    }
    reply(client,id,{ok:true});
    sendState(room);
  }catch(e){reply(client,id,{ok:false,error:e.message});send(client,'actionError',e.message);}
}
function handleMessage(client,message){
  if(!message||typeof message!=='object'||typeof message.event!=='string')return;
  const {event,data={},id}=message;
  if(event==='joinTable'){
    try{
      const previous=room.members.find(m=>data.token&&m.token===data.token);
      let member=previous;
      if(!member){
        if(!nameValid(data.name))throw Error('Enter your name (1–24 characters).');
        const name=data.name.trim();
        if(room.members.some(m=>m.name.toLowerCase()===name.toLowerCase()))
          throw Error('This name is already in the group. Reconnect with the original browser, or ask someone to remove your offline entry.');
        if(room.members.length>=FRIEND_LIMIT)throw Error('All five friend spots are occupied. Ask the group to free an offline entry.');
        const open=room.game.players.findIndex(p=>!p);
        const seat=room.game.phase==='lobby' && open>=0 ? open : null;
        member={id:room.nextMemberId++,name,token:randomBytes(28).toString('hex'),connections:new Set(),online:false,seat};
        room.members.push(member);
        if(seat!==null)room.game.players[seat]=member;
      }
      attach(client,room,member);
      reply(client,id,{ok:true,code:ROOM_CODE,token:member.token,seat:member.seat});sendState(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  if(event==='requestUndo'||event==='voteUndo'){
    handleUndo(client,event,data,id);return;
  }
  if(event==='restoreHistory'){
    try{
      const {seat}=session(client);
      if(seat===null)throw Error('Only a seated friend can restore score backups.');
      if(!Array.isArray(data.records)||data.records.length>200)throw Error('The backup must be a list of up to 200 games.');
      room.history=mergeHistory(room.history,data.records);
      saveHistory(room.history);
      reply(client,id,{ok:true,count:room.history.length});sendState(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}return;
  }
  if(['takeSeat','sitOut','leaveTable','removeOffline','newMatch'].includes(event)){
    try{
      const {member}=session(client);
      if(event==='newMatch'){
        if(room.game.phase!=='summary'||!room.game.finished)throw Error('The current match has not finished.');
        if(room.undoRequest)throw Error('Resolve undo voting before starting a new match.');
        if(room.game.finished)recordFinished(room);
        resetUndo(room);
        const settings=room.game.settings;
        room.game=createGame(settings);
        room.matchId=null;
        for(const m of room.members)if(m.seat!==null)room.game.players[m.seat]=m;
      }else{
        if(room.game.phase!=='lobby')throw Error('Player changes are only allowed before a match starts.');
        if(event==='takeSeat'){
          if(member.seat!==null)throw Error('You already have a seat.');
          const seat=room.game.players.findIndex(p=>!p);
          if(seat<0)throw Error('All three seats are occupied. Ask a player to sit out.');
          member.seat=seat;room.game.players[seat]=member;
        }else if(event==='sitOut'){
          if(member.seat===null)throw Error('You are already waiting.');
          room.game.players[member.seat]=null;member.seat=null;
        }else if(event==='leaveTable'){
          removeMember(room,member);
        }else if(event==='removeOffline'){
          if(member.seat===null)throw Error('Only a seated player can free an inactive entry.');
          const target=room.members.find(m=>m.id===data.memberId);
          if(!target||target.online)throw Error('Only offline group members can be removed.');
          removeMember(room,target);
        }
      }
      reply(client,id,{ok:true});sendState(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  const action=(fn)=>guard(client,event,fn);
  switch(event){
    case 'settings':action((g,seat)=>{
      if(g.phase!=='lobby')throw Error('Settings can only be changed before starting a match.');
      const b=Number(data.startBula),r=Number(data.maxRefe);
      if(!Number.isInteger(b)||b<50||b>120||![2,3,4].includes(r))
        throw Error('Choose bula from 50 to 120 and refe from 2 to 4.');
      const settings=createGame({startBula:b,maxRefe:r}).settings;
      g.settings=settings;
      g.scores.bula=[settings.startBula,settings.startBula,settings.startBula];
    });break;
    case 'start':action((g,seat,room)=>{if(!g.players.every(p=>p?.online))throw Error('Three online players must take seats before dealing.');resetUndo(room);room.matchId=randomBytes(16).toString('hex');deal(g);});break;
    case 'nextRound':action((g,seat,room)=>{if(g.phase!=='summary')throw Error('This round has not ended.');resetUndo(room);deal(g);});break;
    case 'bid':action((g,seat)=>auctionAction(g,seat,data.action,data.value));break;
    case 'takeTalon':action((g,seat)=>takeTalon(g,seat));break;
    case 'discard':action((g,seat)=>discard(g,seat,data.cards));break;
    case 'declare':action((g,seat)=>declare(g,seat,data.value));break;
    case 'follow':action((g,seat)=>follow(g,seat,data.choice ?? data.yes));break;
    case 'call':action((g,seat)=>callPartner(g,seat,data.yes));break;
    case 'double':action((g,seat)=>doubleAction(g,seat,data.action));break;
    case 'play':action((g,seat,room)=>{
      const snapshot=captureGame(g);
      playCard(g,seat,data.card);
      room.undoCandidate={seat,card:data.card,snapshot,at:Date.now()};
      if(g.phase==='trickReview')settleReview(room);
    });break;
  }
}
function readFrames(client,chunk){
  client.buffer=Buffer.concat([client.buffer,chunk]);
  while(client.buffer.length>=2){
    const b=client.buffer;const fin=!!(b[0]&128),opcode=b[0]&15,masked=!!(b[1]&128);
    let size=b[1]&127,offset=2;
    if(size===126){if(b.length<4)return;size=b.readUInt16BE(2);offset=4;}
    else if(size===127){if(b.length<10)return;const length=b.readBigUInt64BE(2);if(length>BigInt(MAX_MESSAGE))return client.socket.destroy();size=Number(length);offset=10;}
    if(!masked||size>MAX_MESSAGE||!fin)return client.socket.destroy();
    if(b.length<offset+4+size)return;
    const mask=b.subarray(offset,offset+4);
    const payload=Buffer.from(b.subarray(offset+4,offset+4+size));
    for(let i=0;i<payload.length;i++)payload[i]^=mask[i%4];
    client.buffer=b.subarray(offset+4+size);
    if(opcode===8){client.socket.end(frame(Buffer.alloc(0),8));return;}
    if(opcode===9){client.socket.write(frame(payload,10));continue;}
    if(opcode===10)continue;
    if(opcode!==1)return client.socket.destroy();
    try{handleMessage(client,JSON.parse(payload.toString('utf8')));}catch(e){send(client,'actionError','Message was not valid JSON.');}
  }
  if(client.buffer.length>MAX_MESSAGE+16)client.socket.destroy();
}
server.on('upgrade',(req,socket,head)=>{
  const origin=req.headers.origin;
  if(origin){
    try{if(new URL(origin).host!==req.headers.host)throw Error('Origin mismatch');}
    catch{socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');return;}
  }
  const key=req.headers['sec-websocket-key'];
  if(req.url!=='/ws'||req.headers.upgrade?.toLowerCase()!=='websocket'||
    typeof key!=='string'||!/^[-A-Za-z0-9+/]{22}==$/.test(key)){
    socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');return;
  }
  const accept=createHash('sha1').update(key+GUID).digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: '+accept+'\r\n\r\n');
  socket.setNoDelay(true);
  const client={id:++socketCounter,socket,buffer:Buffer.alloc(0),closed:false,room:null,seat:null,member:null,token:null};
  clients.set(client.id,client);
  socket.on('data',data=>readFrames(client,data));
  socket.on('error',()=>{});
  socket.on('close',()=>{client.closed=true;detach(client);clients.delete(client.id);});
  if(head.length)readFrames(client,head);
});
// Keep WebSocket connections alive through typical reverse proxies.
setInterval(()=>{
  for(const client of clients.values())if(!client.closed&&client.socket.writable)client.socket.write(frame(Buffer.alloc(0),9));
},25_000).unref();
const port=Number(process.env.PORT||3000);
server.listen(port,'0.0.0.0',()=>console.log(`Preferans online at http://localhost:${port}`));
