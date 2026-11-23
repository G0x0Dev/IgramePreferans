/** Standalone HTTP + WebSocket host: requires only Node.js >=20. */
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import { createGame,deal,auctionAction,takeTalon,discard,declare,follow,callPartner,doubleAction,playCard,advanceTrick,viewFor } from './game.js';

const publicDir=join(dirname(fileURLToPath(import.meta.url)),'public');
const staticPaths=new Map([
  ['/','index.html'],['/index.html','index.html'],['/app.js','app.js'],['/styles.css','styles.css']
]);
const mime={'index.html':'text/html; charset=utf-8','app.js':'application/javascript; charset=utf-8','styles.css':'text/css; charset=utf-8'};
const rooms=new Map();
const clients=new Map();
const codeChars='ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_MESSAGE=24_000;
const GUID='258EAFA5-E914-47DA-95CA-C5AB0DC85B11';
let socketCounter=0;
function makeCode() {
  let code;
  do {code=Array.from({length:6},()=>codeChars[randomBytes(1)[0]%codeChars.length]).join('');}while(rooms.has(code));
  return code;
}
const nameValid=v=>typeof v==='string'&&v.trim().length>=1&&v.trim().length<=24;
const server=http.createServer(async(req,res)=>{
  const url=new URL(req.url,'http://localhost');
  if(url.pathname==='/health'){
    res.writeHead(200,{'Content-Type':'application/json','Cache-Control':'no-store'});
    res.end(JSON.stringify({status:'ok',rooms:rooms.size}));return;
  }
  const file=staticPaths.get(url.pathname);
  if(req.method!=='GET'||!file){res.writeHead(404);res.end('Not found');return;}
  try{
    const bytes=await readFile(join(publicDir,file));
    res.writeHead(200,{
      'Content-Type':mime[file],
      'X-Content-Type-Options':'nosniff',
      'Referrer-Policy':'same-origin',
      'Cache-Control':file==='index.html'?'no-store':'public, max-age=300'
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
  for(const seat of [0,1,2]){
    const player=room.game.players[seat];
    if(!player)continue;
    const view=viewFor(room.game,seat,room.code);
    for(const cid of player.connections)send(clients.get(cid),'state',view);
  }
}
function detach(client){
  const {room,seat}=client;
  if(!room||!Number.isInteger(seat))return;
  const player=room.game.players[seat];
  if(player){player.connections.delete(client.id);player.online=player.connections.size>0;}
  client.room=null;client.seat=null;client.token=null;
  sendState(room);
}
function attach(client,room,seat){
  if(client.room)detach(client);
  const p=room.game.players[seat];
  client.room=room;client.seat=seat;client.token=p.token;
  p.connections.add(client.id);p.online=true;
}
function session(client){
  const {room,seat,token}=client;
  if(!room||!Number.isInteger(seat)||room.game.players[seat]?.token!==token)throw Error('Session expired. Please rejoin.');
  return {room,seat};
}
function guard(client,event,fn){
  try{
    const {room,seat}=session(client);
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
      try{advanceTrick(room.game);sendState(room);}catch(e){console.error(e);}
    }
  },1400);
}
function handleMessage(client,message){
  if(!message||typeof message!=='object'||typeof message.event!=='string')return;
  const {event,data={},id}=message;
  if(event==='createRoom'){
    try{
      if(!nameValid(data.name))throw Error('Enter a name (1–24 characters).');
      if(client.room)detach(client);
      const code=makeCode(),game=createGame(data.settings||{});
      const token=randomBytes(28).toString('hex');
      const room={code,game,updated:Date.now(),timer:null};
      game.players[0]={name:data.name.trim(),token,connections:new Set(),online:false};
      rooms.set(code,room);attach(client,room,0);
      reply(client,id,{ok:true,code,token,seat:0});sendState(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  if(event==='joinRoom'){
    try{
      const code=String(data.code||'').toUpperCase().trim(),room=rooms.get(code);
      if(!room)throw Error('Room not found. Check your invite code.');
      const existing=room.game.players.findIndex(p=>p&&data.token&&p.token===data.token);
      let seat=existing,token=data.token;
      if(existing<0){
        if(!nameValid(data.name))throw Error('Enter a name (1–24 characters).');
        if(room.game.phase!=='lobby')throw Error('The match has started. Reconnect in your original browser.');
        seat=room.game.players.findIndex(p=>!p);
        if(seat<0)throw Error('This room is full (3 players).');
        token=randomBytes(28).toString('hex');
      }
      if(client.room)detach(client);
      if(existing<0)room.game.players[seat]={name:data.name.trim(),token,connections:new Set(),online:false};
      attach(client,room,seat);
      reply(client,id,{ok:true,code,token,seat});sendState(room);
    }catch(e){reply(client,id,{ok:false,error:e.message});}
    return;
  }
  const action=(fn)=>guard(client,event,fn);
  switch(event){
    case 'settings':action((g,seat)=>{
      if(seat!==0||g.phase!=='lobby')throw Error('Only the host may adjust settings before starting.');
      const settings=createGame(data).settings;
      g.settings=settings;
      g.scores.bula=[settings.startBula,settings.startBula,settings.startBula];
    });break;
    case 'start':action((g,seat)=>{if(seat!==0)throw Error('Only host can start.');deal(g);});break;
    case 'nextRound':action(g=>{if(g.phase!=='summary')throw Error('This round has not ended.');deal(g);});break;
    case 'bid':action((g,seat)=>auctionAction(g,seat,data.action,data.value));break;
    case 'takeTalon':action((g,seat)=>takeTalon(g,seat));break;
    case 'discard':action((g,seat)=>discard(g,seat,data.cards));break;
    case 'declare':action((g,seat)=>declare(g,seat,data.value));break;
    case 'follow':action((g,seat)=>follow(g,seat,data.choice ?? data.yes));break;
    case 'call':action((g,seat)=>callPartner(g,seat,data.yes));break;
    case 'double':action((g,seat)=>doubleAction(g,seat,data.action));break;
    case 'play':action((g,seat,room)=>{playCard(g,seat,data.card);if(g.phase==='trickReview')settleReview(room);});break;
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
  const client={id:++socketCounter,socket,buffer:Buffer.alloc(0),closed:false,room:null,seat:null,token:null};
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
// Clean up inactive rooms after 48 hours; an active room requires a single process.
setInterval(()=>{
  const now=Date.now();
  for(const [code,room] of rooms)if(now-room.updated>48*60*60*1000){if(room.timer)clearTimeout(room.timer);rooms.delete(code);}
},60*60*1000).unref();
const port=Number(process.env.PORT||3000);
server.listen(port,'0.0.0.0',()=>console.log(`Preferans online at http://localhost:${port}`));
