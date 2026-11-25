/** Standalone HTTP + WebSocket host: requires only Node.js >=20. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { connectScoreStore } from './score-store.js';
import { requireScoreAdmin,checkResetAllowed } from './score-admin.js';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createGame,deal,auctionAction,igraDeclare,takeTalon,discard,declare,follow,callPartner,doubleAction,playCard,advanceTrick,viewFor,finalScores,settleMatch } from './game.js';
import { mergeHistory,leaderboard,normalizeRecord,MAX_HISTORY } from './history.js';
import { botMove } from './bot.js';

const publicDir=join(dirname(fileURLToPath(import.meta.url)),'public');
const staticPaths=new Map([
  ['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css']
]);
const mime={'index.html':'text/html; charset=utf-8','app.js':'application/javascript; charset=utf-8','styles.css':'text/css; charset=utf-8'};
const clients=new Map();
const ROOM_CODE='FRIENDS';
const FRIEND_LIMIT=5;
const sharedRoom={code:ROOM_CODE,game:createGame(),members:[],nextMemberId:1,updated:Date.now(),timer:null,archiveTimer:null,history:[],historyEpoch:null,archivingIds:new Set(),undoCandidate:null,undoRequest:null,settlementRequest:null,matchId:null,solo:false};
const soloRooms=new Map();
const SOLO_LIMIT=30;
const MAX_MESSAGE=128_000; // bounded backup import and latest score rows
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let socketCounter=0;
let scoreStore=null;
let scoreQueue=Promise.resolve();
function queueScoreWrite(operation){
  const task=scoreQueue.then(operation);
  scoreQueue=task.catch(()=>{});
  return task;
}
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
  if(room.game.finished && !room.archiveTimer && !room.undoRequest && room.matchId && !room.history.some(h=>h.id===room.matchId) && !room.archivingIds?.has(room.matchId))scheduleArchive(room);
  const members=room.members.map(m=>({id:m.id,name:m.name,online:m.online,seat:m.seat}));
  for(const member of room.members){
    const view=viewFor(room.game,member.seat,room.code);
    view.members=members;
    view.memberId=member.id;
    view.myName=member.name;
    view.friendLimit=FRIEND_LIMIT;
    view.mode=room.solo?'solo':'friends';
    view.history=room.solo?[]:room.history.slice(0,MAX_HISTORY);
    view.historyEpoch=room.solo?null:room.historyEpoch;
    view.leaderboard=room.solo?[]:leaderboard(room.history);
    view.undoRequest=room.undoRequest ? {seat:room.undoRequest.seat,card:room.undoRequest.card,approvals:room.undoRequest.approvals} : null;
    view.settlementRequest=room.settlementRequest
      ? {seat:room.settlementRequest.seat,approvals:[...room.settlementRequest.approvals]} : null;
    view.canSettle=!room.solo && member.seat!==null && room.game.round>0 &&
      room.game.phase==='summary' && !room.game.finished && !room.settlementRequest && !room.undoRequest;
    view.canUndo=!room.solo && !!room.undoCandidate && !room.undoRequest && !room.settlementRequest && room.undoCandidate.seat===member.seat && Date.now()-room.undoCandidate.at<=30000 && ['playing','trickReview','summary'].includes(room.game.phase);
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
    send(connection,'leftTable',{mode:'friends'});
  }
  member.connections.clear();member.online=false;member.seat=null;
}
function guard(client,event,fn){
  try{
    const {room,seat}=session(client);
    if(seat===null)throw Error('You are waiting. Choose a seat before playing.');
    if(room.undoRequest)throw Error('An undo request is awaiting both opponents.');
    if(room.settlementRequest)throw Error('The players are voting on otpisivanje; finish the vote first.');
    fn(room.game,seat,room);
    room.updated=Date.now();
    if(process.env.DEBUG_GAME)console.log(room.code,seat,event,room.game.phase);
    sendState(room);
    scheduleBots(room);
  }catch(e){send(client,'actionError',e.message||'Invalid action.');}
}
function settleReview(room){
  if(room.timer)clearTimeout(room.timer);
  room.timer=setTimeout(()=>{
    room.timer=null;
    if(room.game.phase==='trickReview'){
      try{advanceTrick(room.game);if(room.game.finished)scheduleArchive(room);sendState(room);scheduleBots(room);}catch(e){console.error(e);}
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
  if(room.solo)return;
  if(!room.game.finished || !room.matchId || room.history.some(h=>h.id===room.matchId) ||
     room.archivingIds.has(room.matchId))return;
  const record={
    id:room.matchId,at:new Date().toISOString(),rounds:room.game.round,
    players:room.game.players.map((p,i)=>({name:p.name,score:finalScores(room.game)[i]}))
  };
  room.archivingIds.add(record.id);
  // Serialize all saves, imports and wipes. A reset always runs after any
  // already-in-flight match save, so an old match cannot reappear afterwards.
  void queueScoreWrite(async()=>{
    await scoreStore.add(record);
    room.history=mergeHistory(room.history,[record]);
    sendState(room);
  }).catch(e=>{
    console.error('Could not archive completed match:',e.message);
    if(room.matchId===record.id){
      clearArchiveTimer(room);
      room.archiveTimer=setTimeout(()=>{
        room.archiveTimer=null;recordFinished(room);
      },15_000);
      room.archiveTimer.unref?.();
    }
  }).finally(()=>room.archivingIds.delete(record.id));
}
function scheduleArchive(room){
  if(room.solo)return;
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
// Solo practice uses independent rooms, never seats or scoring from the friends' table.
function newSoloRoom(name){
  if(soloRooms.size>=SOLO_LIMIT){
    for(const [token,old] of soloRooms){
      if(!old.members[0].online && Date.now()-old.updated>15*60*1000)soloRooms.delete(token);
    }
    if(soloRooms.size>=SOLO_LIMIT)throw Error('Practice is full right now. Try again later.');
  }
  const token=randomBytes(28).toString('hex');
  const human={id:1,name,seat:0,token,connections:new Set(),online:false};
  const bot1={id:2,name:'Computer 1',seat:1,bot:true,connections:new Set(),online:true};
  const bot2={id:3,name:'Computer 2',seat:2,bot:true,connections:new Set(),online:true};
  const game=createGame();
  game.players=[human,bot1,bot2];
  const room={code:'PRACTICE',game,members:[human,bot1,bot2],nextMemberId:4,updated:Date.now(),
    timer:null,archiveTimer:null,botTimer:null,history:[],undoCandidate:null,undoRequest:null,settlementRequest:null,matchId:null,solo:true};
  soloRooms.set(token,room);
  return {room,member:human};
}
function resetPractice(room){
  if(room.botTimer){clearTimeout(room.botTimer);room.botTimer=null;}
  if(room.timer){clearTimeout(room.timer);room.timer=null;}
  resetUndo(room);
  const settings=room.game.settings;
  room.game=createGame(settings);
  room.game.players=room.members;
  room.matchId=null;
}
function scheduleBots(room){
  if(!room.solo||room.botTimer||room.game.phase==='trickReview'||room.game.phase==='summary'||room.game.phase==='lobby')return;
  const seat=room.game.turn;
  if(!Number.isInteger(seat)||!room.game.players[seat]?.bot)return;
  const configured=Number(process.env.BOT_DELAY_MS);
  const delay=process.env.BOT_DELAY_MS!==undefined && Number.isFinite(configured)
    ? Math.max(0,Math.min(2000,configured)):280;
  room.botTimer=setTimeout(()=>{
    room.botTimer=null;
    if(!room.solo||!room.game.players[room.game.turn]?.bot)return;
    try{
      const didMove=botMove(room.game);
      if(!didMove)return;
      if(room.game.phase==='trickReview')settleReview(room);
      sendState(room);
      scheduleBots(room);
    }catch(e){console.error('Computer move failed:',e);}
  },delay);
}
function handleUndo(client,event,data,id){
  try{
    const {seat,room}=session(client);
    if(room.solo)throw Error('Consensus undo is for human games; use Restart practice for a fresh game.');
    if(seat===null)throw Error('Only seated players can request or approve an undo.');
    const candidate=room.undoCandidate;
    if(event==='requestUndo'){
      if(room.undoRequest)throw Error('An undo request is already pending.');
      if(room.settlementRequest)throw Error('Wait for the otpisivanje vote to finish.');
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
function clearSettlementRequest(room){
  if(room.settlementRequest?.timer)clearTimeout(room.settlementRequest.timer);
  room.settlementRequest=null;
}
function handleSettlement(client,event,data,id){
  try{
    const {room,seat}=session(client);
    if(room.solo)throw Error('Otpisivanje requires three human players in the friends room.');
    if(seat===null)throw Error('Only seated players can approve match settlement.');
    if(event==='requestSettlement'){
      if(room.game.phase!=='summary'||room.game.finished||room.game.round<1)
        throw Error('Settlement can only start between hands of an unfinished match.');
      if(room.settlementRequest)throw Error('Otpisivanje is already awaiting votes.');
      if(room.undoRequest)throw Error('Resolve the pending undo request first.');
      if(!room.game.players.every(p=>p?.online))
        throw Error('All three seated players must be online to agree on settlement.');
      const request={seat,approvals:[false,false,false],started:Date.now(),timer:null};
      request.approvals[seat]=true;
      room.settlementRequest=request;
      request.timer=setTimeout(()=>{
        if(room.settlementRequest===request){
          clearSettlementRequest(room);
          sendState(room);
        }
      },30000);
      request.timer.unref?.();
    }else if(event==='voteSettlement'){
      const request=room.settlementRequest;
      if(!request)throw Error('There is no otpisivanje request.');
      if(seat===request.seat)throw Error('Only the other two players can vote.');
      if(typeof data.approve!=='boolean')throw Error('Choose approve or reject.');
      if(request.approvals[seat])throw Error('You have already voted.');
      if(!data.approve){
        clearSettlementRequest(room);
      }else{
        request.approvals[seat]=true;
        if(request.approvals.every(Boolean)){
          // All three have now consented, and all cards from the last
          // hand have already been scored. No late Undo can reverse this.
          settleMatch(room.game);
          clearSettlementRequest(room);
          resetUndo(room);
          recordFinished(room);
        }
      }
    }else throw Error('Unknown settlement action.');
    reply(client,id,{ok:true,finished:room.game.finished});
    sendState(room);
  }catch(e){reply(client,id,{ok:false,error:e.message});send(client,'actionError',e.message);}
}
async function handleScoreAdministration(client,event,data,id){
  try{
    const {room}=session(client);
    if(room!==sharedRoom || room.solo)throw new Error('Score administration is only available in the friends room.');
    if(client.adminBlockedUntil && Date.now()<client.adminBlockedUntil)
      throw new Error('Too many incorrect passwords. Try again in one minute.');
    try{
      requireScoreAdmin(data.adminSecret,process.env.ADMIN_RESET_SECRET);
      client.adminFailures=0;
    }catch(e){
      client.adminFailures=(client.adminFailures||0)+1;
      if(client.adminFailures>=5){client.adminBlockedUntil=Date.now()+60_000;client.adminFailures=0;}
      throw e;
    }
    if(event==='restoreHistory'){
      if(!Array.isArray(data.records)||data.records.length>MAX_HISTORY)
        throw new Error('Backup must contain at most 200 games per import.');
      const records=data.records.map(normalizeRecord);
      if(records.some(r=>!r))throw new Error('Backup contains an invalid score record.');
      await queueScoreWrite(async()=>{
        await scoreStore.importRecords(records);
        const snapshot=await scoreStore.load();
        room.history=snapshot.history;room.historyEpoch=snapshot.epoch;
      });
      reply(client,id,{ok:true,count:room.history.length});
    }else{
      checkResetAllowed(room.game,data.confirmation);
      clearArchiveTimer(room);
      await queueScoreWrite(async()=>{
        const epoch=await scoreStore.reset();
        room.history=[];room.historyEpoch=epoch;
        // A finished match must not be re-archived after wiping its results.
        if(room.game.finished)room.matchId=null;
      });
      reply(client,id,{ok:true});
    }
    sendState(room);
  }catch(e){
    console.error('Score administration failed:',event,e.message);
    reply(client,id,{ok:false,error:e.message});
  }
}
function handleMessage(client,message){
  if(!message||typeof message!=='object'||typeof message.event!=='string')return;
  const {event,data={},id}=message;
  if(event==='joinSolo'){
    try{
      let target=null;
      if(data.token && typeof data.token==='string' && soloRooms.has(data.token)){
        const room=soloRooms.get(data.token);
        target={room,member:room.members[0]};
      }
      if(!target){
        if(data.token)throw Error('The previous practice session has expired. Start a new one.');
        if(!nameValid(data.name))throw Error('Enter a name of 1–24 characters.');
        target=newSoloRoom(data.name.trim());
      }
      attach(client,target.room,target.member);
      reply(client,id,{ok:true,token:target.member.token,seat:0,mode:'solo'});
      sendState(target.room);
      scheduleBots(target.room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  if(event==='exitSolo'){
    try{
      if(!client.room?.solo)throw Error('You are not in practice mode.');
      const old=client.room,token=old.members[0].token;
      detach(client);soloRooms.delete(token);
      if(old.botTimer)clearTimeout(old.botTimer);
      if(old.timer)clearTimeout(old.timer);
      reply(client,id,{ok:true});
      send(client,'leftTable',{mode:'solo'});
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  if(event==='joinTable'){
    const room=sharedRoom;
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
  const room=client.room||sharedRoom;
  if(event==='requestSettlement'||event==='voteSettlement'){
    handleSettlement(client,event,data,id);return;
  }
  if(event==='requestUndo'||event==='voteUndo'){
    handleUndo(client,event,data,id);return;
  }
  if(event==='restoreHistory'||event==='resetScores'){
    void handleScoreAdministration(client,event,data,id);
    return;
  }
  if(event==='restartSolo'){
    try{
      const {room,seat}=session(client);
      if(!room.solo||seat!==0)throw Error('Restart is only available to the practice player.');
      resetPractice(room);reply(client,id,{ok:true});sendState(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  if(['takeSeat','sitOut','leaveTable','removeOffline','newMatch'].includes(event)){
    try{
      const {member}=session(client);
      if(event==='newMatch'){
        if(room.game.phase!=='summary'||!room.game.finished)throw Error('The current match has not finished.');
        if(room.undoRequest)throw Error('Resolve undo voting before starting a new match.');
        if(room.settlementRequest)throw Error('Resolve settlement voting before starting a new match.');
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
      scheduleBots(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  const action=(fn)=>guard(client,event,fn);
  switch(event){
    case 'settings':action((g,seat)=>{
      if(g.phase!=='lobby')throw Error('Settings can only be changed before starting a match.');
      const b=Number(data.startBula),r=Number(data.maxRefe);
      const pikNoKontra=data.pikNoKontra===undefined?g.settings.pikNoKontra:data.pikNoKontra;
      if(!Number.isInteger(b)||b<50||b>120||![2,3,4].includes(r)||
          !['declarer','all'].includes(pikNoKontra))
        throw Error('Choose bula 50–120, refe 2–4 and a valid Pik-without-Kontra rule.');
      const settings=createGame({startBula:b,maxRefe:r,pikNoKontra}).settings;
      g.settings=settings;
      g.scores.bula=[settings.startBula,settings.startBula,settings.startBula];
    });break;
    case 'start':action((g,seat,room)=>{if(!g.players.every(p=>p?.online))throw Error('Three online players must take seats before dealing.');resetUndo(room);if(!room.solo)room.matchId=randomBytes(16).toString('hex');deal(g);});break;
    case 'nextRound':action((g,seat,room)=>{if(g.phase!=='summary')throw Error('This round has not ended.');resetUndo(room);deal(g);});break;
    case 'bid':action((g,seat)=>auctionAction(g,seat,data.action,data.value));break;
    case 'igraDeclare':action((g,seat)=>igraDeclare(g,seat,data.value));break;
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
connectScoreStore().then(async store=>{
  scoreStore=store;
  const snapshot=await store.load();
  sharedRoom.history=snapshot.history;
  sharedRoom.historyEpoch=snapshot.epoch;
  console.log('Score archive ready:',store.kind);
  server.listen(port,'0.0.0.0',()=>console.log(`Preferans online at http://localhost:${port}`));
}).catch(e=>{
  // Never run with an empty in-memory archive if a configured DB fails.
  console.error('Cannot initialize score archive:',e.message);
  process.exitCode=1;
});
