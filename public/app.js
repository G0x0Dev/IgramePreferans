(() => {
  const $ = (selector) => document.querySelector(selector);
  const root = $('#root');
  // Browser-native WebSockets: no framework or external JS needed.
  function liveSocket() {
    const listeners=new Map(),pending=new Map();
    let ws=null,sequence=0,attempt=0,connectionNumber=0,stopped=false;
    const api={
      on(event,fn){if(!listeners.has(event))listeners.set(event,[]);listeners.get(event).push(fn);},
      emit(event,data,callback){
        if(typeof data==='function'){callback=data;data={};}
        if(!ws||ws.readyState!==WebSocket.OPEN){callback?.({ok:false,error:'Connection is offline.'});return;}
        const id=++sequence;
        if(callback)pending.set(id,callback);
        ws.send(JSON.stringify({event,data:data||{},id}));
      }
    };
    function dispatch(event,data){(listeners.get(event)||[]).forEach(fn=>fn(data));}
    function connect(){
      if(stopped)return;
      const scheme=location.protocol==='https:'?'wss:':'ws:';
      ws=new WebSocket(`${scheme}//${location.host}/ws`);
      const current=++connectionNumber;
      ws.onopen=()=>{if(current!==connectionNumber)return;attempt=0;dispatch('connect');};
      ws.onmessage=event=>{
        let msg;try{msg=JSON.parse(event.data);}catch{return;}
        if(msg.event==='ack'){
          const cb=pending.get(msg.data.id);pending.delete(msg.data.id);cb?.(msg.data.result);
        } else dispatch(msg.event,msg.data);
      };
      ws.onclose=()=>{
        if(current!==connectionNumber)return;
        pending.forEach(cb=>cb({ok:false,error:'Connection interrupted.'}));pending.clear();
        dispatch('disconnect');
        if(!stopped)setTimeout(connect,Math.min(1500*2**attempt++,10000));
      };
      ws.onerror=()=>{};
    }
    connect();return api;
  }
  const socket = liveSocket();
  const SUITS = {S:'♠',D:'♦',H:'♥',C:'♣'};
  const CONTRACTS = [{v:2,n:'Pik',s:'S'},{v:3,n:'Karo',s:'D'},{v:4,n:'Herc',s:'H'},{v:5,n:'Tref',s:'C'},{v:6,n:'Betl',s:null},{v:7,n:'Sans',s:null}];
  let state=null, session=null, selected=[], connected=false, working=false;
  let alertText=''; let toastTimer;
  const esc = value => String(value??'').replace(/[&<>"']/g,s=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[s]));
  const seats = i => (i+3)%3;
  const rightOf = i => (i+1)%3;
  const nameOf = i => state?.players?.[i]?.name||`Player ${i+1}`;
  const phaseTitle = {lobby:'Waiting for players',auction:'The auction',igraReveal:'Declare your Igra',talon:'The talon',discard:'Discard two cards',contract:'Choose your contract',following:'Defenders decide',calling:'Invite a partner',doubles:'Kontra & raises',playing:'Trick-taking',trickReview:'Trick complete',summary:'Round results'};
  const contractName = (v,hand=false) => `${hand?'Igra-':''}${CONTRACTS.find(c=>c.v===v)?.n||'?'}`;
  const seatLabel = i => i===state.seat?'You':nameOf(i);
  const SESSION_KEY='pref3:friends';
  const SOLO_KEY='pref3:solo';
  const MODE_KEY='pref3:lastMode';
  const HISTORY_KEY='pref3:matchHistory';
  const HISTORY_EPOCH_KEY='pref3:matchHistoryEpoch';
  function rememberSession(data,mode='friends') {
    session={token:data.token,mode};
    localStorage.setItem(mode==='solo'?SOLO_KEY:SESSION_KEY,JSON.stringify(session));
    localStorage.setItem(MODE_KEY,mode);
    history.replaceState(null,'',location.pathname);
  }
  function toast(message) {
    const node=$('#toast');node.textContent=message;node.classList.add('show');
    clearTimeout(toastTimer); toastTimer=setTimeout(()=>node.classList.remove('show'),3700);
  }
  function sayError(message){alertText=message;toast(message);render();}
  function emitAck(event,payload,callback) {
    working=true;
    socket.emit(event,payload,result=>{
      working=false;
      if(!result?.ok){sayError(result?.error||'Could not join the table.');callback?.(false);return;}
      alertText='';rememberSession(result,event==='joinSolo'?'solo':'friends');callback?.(true);render();
    });
  }
  function reconnect(mode=null) {
    const selectedMode=mode||session?.mode||localStorage.getItem(MODE_KEY)||'friends';
    const key=selectedMode==='solo'?SOLO_KEY:SESSION_KEY;
    let saved=selectedMode===session?.mode?session:null;
    if(!saved){try{saved=JSON.parse(localStorage.getItem(key)||'null');}catch{}}
    if(!saved?.token)return;
    const event=selectedMode==='solo'?'joinSolo':'joinTable';
    socket.emit(event,{token:saved.token},answer=>{
      if(answer?.ok){rememberSession(answer,selectedMode);alertText='';render();}
      else {
        state=null;session=null;localStorage.removeItem(key);localStorage.removeItem(MODE_KEY);
        alertText=selectedMode==='solo'?'Your practice session expired. Start a new solo game.':
          'Your previous session is no longer available. Enter your name to join the shared table.';
        render();
      }
    });
  }
  socket.on('connect',()=>{connected=true;reconnect();render();});
  socket.on('disconnect',()=>{connected=false;render();});
  socket.on('leftTable',data=>{
    const mode=data?.mode||session?.mode||state?.mode||'friends';
    localStorage.removeItem(mode==='solo'?SOLO_KEY:SESSION_KEY);
    if(localStorage.getItem(MODE_KEY)===mode)localStorage.removeItem(MODE_KEY);
    state=null;session=null;render();
  });
  // Animate only a freshly appended card, not the whole trick each time
  // the server sends a score/turn update. Reconnects and rerenders remain still.
  function freshPlayedCard(previous,next){
    if(!previous||previous.round!==next.round ||
       !['playing','trickReview'].includes(previous.phase)||
       !['playing','trickReview','summary'].includes(next.phase))return null;
    const before=previous.trick||[],after=next.trick||[];
    if(after.length!==before.length+1)return null;
    if(!before.every((p,i)=>after[i]?.seat===p.seat&&after[i]?.card===p.card))return null;
    return after[after.length-1];
  }
  socket.on('state',g=>{
    const newlyPlayed=freshPlayedCard(state,g);
    state=g;selected=selected.filter(c=>g.hands.includes(c));
    if(g.mode!=='solo'){
      try{
        const savedEpoch=localStorage.getItem(HISTORY_EPOCH_KEY);
        if(savedEpoch&&savedEpoch!==g.historyEpoch)localStorage.removeItem(HISTORY_KEY);
        if(g.historyEpoch)localStorage.setItem(HISTORY_EPOCH_KEY,g.historyEpoch);
        // Browser copy is only a downloadable convenience backup. It never
        // uploads scores automatically; an administrator must import a file.
        if(g.history?.length)localStorage.setItem(HISTORY_KEY,JSON.stringify(g.history));
        else localStorage.removeItem(HISTORY_KEY);
      }catch{}
    }
    render(newlyPlayed);
  });
  socket.on('actionError',message=>sayError(message));

  const icon = c => `<span class="suit-symbol ${['D','H'].includes(c.s)?'red':''}">${c.s?SUITS[c.s]:''}</span>`;
  // French-suited 32-card deck: pip patterns for 7–10, Ace and framed royal faces.
  function cardFace(rank,symbol) {
    if(rank==='A') return `<div class="french-ace">${symbol}</div>`;
    if(['J','Q','K'].includes(rank)){
      const emblem=rank==='K'?'♛':rank==='Q'?'♕':'⚜';
      return `<div class="french-court"><div class="court-crest">${emblem}</div><div class="court-person"><span class="court-hat">♛</span><span class="court-head">●</span><span class="court-robe">${symbol}</span></div><div class="court-medallion">${rank}</div><div class="court-foot">${symbol} ✦ ${symbol}</div></div>`;
    }
    const patterns={
      '7': [[0,0],[1,0],[0,1],[1,1],[0,2],[1,2],[.5,1.5]],
      '8': [[0,0],[1,0],[0,1],[1,1],[0,2],[1,2],[.5,.5],[.5,1.5]],
      '9': [[0,0],[1,0],[0,1],[1,1],[0,2],[1,2],[.5,.3],[.5,1.1],[.5,1.9]],
      '10':[[0,0],[1,0],[0,1],[1,1],[0,2],[1,2],[.5,.2],[.5,.8],[.5,1.4],[.5,2]]
    };
    const pips=(patterns[rank]||[]).map(([x,y])=>{
      const left=x===0?'21%':x===1?'79%':'50%';
      const top=(18+y*31)+'%';
      return `<span class="french-pip" style="left:${left};top:${top}">${symbol}</span>`;
    }).join('');
    return `<div class="french-pips">${pips}</div>`;
  }
  function cardHtml(c,{tiny=false,disabled=false,selectable=false,selectedCard=false}={}) {
    if(!c)return `<div class="playing-card back ${tiny?'tiny':''}" aria-label="Face-down card"><span class="back-emblem">♠</span></div>`;
    const suit=c[0],rank=c.slice(1),symbol=SUITS[suit];
    const red=suit==='D'||suit==='H';
    const rankLabel={J:'Jack',Q:'Queen',K:'King',A:'Ace'}[rank]||rank;
    const suitLabel={S:'Spades',D:'Diamonds',C:'Clubs',H:'Hearts'}[suit];
    return `<div class="playing-card french-card ${tiny?'tiny':''} ${red?'red':'black'} ${disabled?'disabled':''} ${selectedCard?'selected':''}" ${selectable?`data-card="${esc(c)}" role="button" tabindex="0" aria-label="${rankLabel} of ${suitLabel}"`:''}>
      <span class="card-corner"><b>${esc(rank)}</b><small>${symbol}</small></span>
      <span class="french-face" aria-hidden="true">${cardFace(rank,symbol)}</span>
      <img class="north-german-face" src="/cards/north-german/${esc(c)}.png" alt="" aria-hidden="true" draggable="false" onerror="this.hidden=true">
      <span class="card-corner mirrored" aria-hidden="true"><b>${esc(rank)}</b><small>${symbol}</small></span></div>`;
  }
  function button(title,action,opts={}) {
    const {value,variant='',disabled=false,extra=''}=opts;
    return `<button type="button" class="button ${variant}" data-action="${action}" ${value!==undefined?`data-value="${esc(value)}"`:''} ${disabled?'disabled':''}>${extra}${esc(title)}</button>`;
  }
  function header() {
    return `<header class="topbar"><div class="brand"><span class="brandmark">♠</span><div><h1>Preferans</h1><small>Private card table</small></div></div>
    <div class="top-actions"><span class="pill"><i class="online-dot ${connected?'':'off'}"></i>${connected?'Connected':'Reconnecting'}</span>
    ${state?.mode==='solo'?button('Back to friends','exitSolo',{variant:'small'}):state?button('Copy table link','share',{variant:'small'}):''}
    ${state?.mode==='friends'&&['lobby','summary'].includes(state.phase)?button('Solo practice','startSolo',{variant:'small subtle'}):''}</div></header>`;
  }
  function welcome() {
    return `<div class="app">${header()}<section class="welcome">
      <div class="welcome-copy"><div class="overline">Your friends' Preferans table</div><h2>One table.<br><em>Five friends.</em></h2>
      <p>Use the same link every time. Three friends play each match, while up to two others can wait and watch public tricks. No room codes or room creation needed.</p>
      <div class="welcome-feature"><span class="feature">♠ One shared table</span><span class="feature">♣ Three active players</span><span class="feature">♥ Two waiting places</span><span class="feature">♦ Automatic scoring</span></div></div>
      <div class="form-box"><span class="eyebrow">Shared table</span><h3>Ready to play?</h3><p>Enter your name once. You’ll return to the same group when you open the site again on this device.</p>
      ${alertText?`<div class="warning">${esc(alertText)}</div>`:''}
      <form id="join-form"><label class="field-label" for="player-name">Your name</label><input class="text-field" name="name" id="player-name" maxlength="24" autocomplete="nickname" required placeholder="Enter your name" value="${esc(localStorage.getItem('pref3:lastName')||'')}" />
      <button class="button primary large" type="submit" ${!connected||working?'disabled':''}>Join our table</button></form>
      <div class="line-or">or</div>
      <button class="button primary large practice-entry" data-action="startSolo" ${!connected||working?'disabled':''}>Play solo vs 2 computers</button>
      <p class="muted-note">Solo practice uses a private session and does not change your friends' game or all-time scores.</p>
      </div>
      </section></div>`;
  }
  function matchHistory() {
    if(state.mode==='solo')return `<section class="panel panel-pad match-history">
      <span class="eyebrow">Training only</span><h3 class="side-title">Practice game</h3>

      ${button('Restart practice','restartSolo',{variant:'small subtle'})}
    </section>`;
    const rows=state.leaderboard||[],games=state.history||[];
    return `<section class="panel panel-pad match-history"><span class="eyebrow">Across all finished matches</span>
      <h3 class="side-title">Friends' standings</h3>
      ${rows.length?`<table class="score-table standings-table"><thead><tr><th>Place</th><th>Player</th><th>Games</th><th>Wins</th><th>Total score</th></tr></thead><tbody>
      ${rows.map(p=>`<tr class="${p.position===1?'leader-row':''}"><td>#${p.position}</td><td>${esc(p.name)}</td><td>${p.games}</td><td>${p.wins}</td><td class="number">${p.total}</td></tr>`).join('')}</tbody></table>`
      :'<p class="muted-note">No finished matches yet. Scores are added after a match ends.</p>'}
      
      <div class="action-row">${button('Download results backup','exportHistory',{variant:'small'})}${state.seat===null?'':button('Restore backup','importHistory',{variant:'small subtle'})}
      ${state.seat!==null&&(state.phase==='lobby'||(state.phase==='summary'&&state.finished))?button('Reset all scores','resetScores',{variant:'small warn'}):''}</div>
      <h4 class="history-title">Finished games (${games.length})</h4>
      ${games.length?`<div class="history-list">${games.slice(0,12).map((m,i)=>`<div class="history-match"><strong>Game ${games.length-i} · ${esc(new Date(m.at).toLocaleDateString())}</strong><small>${esc(m.players.map(p=>p.name+': '+p.score).join(' · '))}</small></div>`).join('')}</div>`:
      '<p class="muted-note">No finished games</p>'}

      
    </section>`;
  }
  function undoBanner() {
    const u=state.undoRequest;
    if(u){
      const requester=esc(nameOf(u.seat)),myTurn=state.seat!==null&&state.seat!==u.seat;
      const responded=myTurn&&u.approvals[state.seat];
      return `<div class="undo-notice"><strong>Undo requested by ${requester}</strong><p>Replay the last card (${esc(u.card)})? Both other players must agree; play is paused.</p>
      ${myTurn&&!responded?`<div class="action-row">${button('Approve undo','approveUndo',{variant:'primary'})}${button('Reject undo','rejectUndo',{variant:'subtle'})}</div>`:
        responded?'<p>Approved — waiting for the other player.</p>':'<p>Waiting for both other players to decide.</p>'}</div>`;
    }
    return state.canUndo ? `<div class="undo-trigger">${button('Undo my last card · ask both players','requestUndo',{variant:'small subtle'})}</div>`:'';
  }
  function lobby() {
    if(state.mode==='solo')return `<div class="app">${header()}<main class="lobby">
      <div class="lobby-hero"><span class="eyebrow">Solo practice</span><h2>You vs two computers</h2>
      <p>The computer players will bid, defend and play their cards automatically. This session is separate from your friends' table.</p></div>
      <div class="lobby-seats">${state.players.map((p,i)=>`<div class="lobby-seat"><div class="avatar">${i===0?'♠':'🤖'}</div>
      <strong>${esc(p.name)}</strong><small>${i===0?'You':'Computer opponent'}</small></div>`).join('')}</div>
      <section class="panel panel-pad" style="margin-top:23px"><span class="eyebrow">Practice settings</span>
      <h3 class="side-title">Choose bula & refe</h3>
      <div class="lobby-settings"><div><label for="start-bula">Bula (50–120)</label>
      <select id="start-bula" data-settings>${Array.from({length:8},(_,i)=>50+i*10).map(v=>`<option ${state.settings.startBula===v?'selected':''} value="${v}">${v} bula</option>`).join('')}</select></div>
      <div><label for="max-refe">Refe (2–4)</label><select id="max-refe" data-settings>
      ${[2,3,4].map(v=>`<option ${state.settings.maxRefe===v?'selected':''} value="${v}">${v} per player</option>`).join('')}</select></div></div>
            <div class="pik-rule"><label for="pik-no-kontra">Pik without Kontra</label>
      <select id="pik-no-kontra" data-settings ${state.mode==='friends'&&!isHost?'disabled':''}>
      <option value="declarer" ${state.settings.pikNoKontra!=='all'?'selected':''}>Refe to declarer (default)</option>
      <option value="all" ${state.settings.pikNoKontra==='all'?'selected':''}>Refe to all eligible players</option>
      </select><p class="muted-note">If no eligible refe can be recorded, the Pik declarer automatically passes. No cards are played.</p></div></section>
      <div class="lobby-foot"><div class="action-row" style="justify-content:center">
      ${button('Deal cards · Start practice','start',{variant:'primary large'})}
      ${button('Back to friends','exitSolo',{variant:'subtle'})}</div></div>
      </main></div>`;
    const playerCount=state.players.filter(Boolean).length;
    const isHost=state.seat!==null;
    const waiting=state.members.filter(m=>m.seat===null);
    const canStart=playerCount===3 && state.players.every(p=>p?.online);
    return `<div class="app">${header()}<main class="lobby">
      <div class="lobby-hero"><span class="eyebrow">One shared table</span><h2>Choose three players.</h2>
      <p>${playerCount} of 3 playing seats · ${state.members.length} of ${state.friendLimit} friends joined. Everyone uses the same website link.</p></div>
      <div class="lobby-seats">${state.players.map((p,i)=>`<div class="lobby-seat"><div class="avatar">${esc(p?.name?.charAt(0)?.toUpperCase()||'?')}</div>
      <strong>${esc(p?.name||'Open seat')}</strong><small>${p?`${i===state.seat?'You · ':''}${p.online?'Online':'Offline'}`:'Available to play'}</small>${p&&!p.online&&isHost?button('Free offline seat','removeOffline',{value:state.members.find(m=>m.seat===i)?.id,variant:'small subtle'}):''}</div>`).join('')}</div>
      <div class="copy-url"><span class="text-muted">One link for everyone</span>${button('Copy table link','share',{variant:'small'})}</div>
      <section class="panel panel-pad" style="margin-top:22px"><span class="eyebrow">Friends</span><h3 class="side-title">Waiting / next match</h3>
      <div class="friends-list">${waiting.length?waiting.map(m=>`<span class="friend-tag">${esc(m.name)} <small>${m.online?'Online':'Offline'} · Waiting</small> ${!m.online&&isHost?button('Remove offline','removeOffline',{value:m.id,variant:'small subtle' }):''}</span>`).join(''):'<p class="muted-note">No one waiting right now.</p>'}</div>
      <p class="muted-note">Three people play at a time. Players can choose to sit out before the deal so waiting friends can take a free seat.</p>
      <div class="action-row">${isHost?button('Sit out this match','sitOut',{variant:'subtle'}):playerCount<3?button('Take an open seat','takeSeat',{variant:'primary'}):'<span class="text-muted">All playing seats are occupied. Ask a friend to sit out.</span>'}${button('Leave the group','leaveTable',{variant:'subtle'})}</div></section>
            <section class="panel panel-pad" style="margin-top:24px"><span class="eyebrow">Before the deal</span><h3 class="side-title">Choose bula & refe</h3>
      <div class="lobby-settings"><div><label for="start-bula">Bula (50–120)</label><select id="start-bula" data-settings ${!isHost?'disabled':''}>${Array.from({length:8},(_,i)=>50+i*10).map(v=>`<option ${state.settings.startBula===v?'selected':''} value="${v}">${v} bula</option>`).join('')}</select></div>
      <div><label for="max-refe">Refe (2–4)</label><select id="max-refe" data-settings ${!isHost?'disabled':''}>${[2,3,4].map(v=>`<option ${state.settings.maxRefe===v?'selected':''} value="${v}">${v} per player</option>`).join('')}</select></div></div>
            <div class="pik-rule"><label for="pik-no-kontra">Pik without Kontra</label>
      <select id="pik-no-kontra" data-settings ${state.mode==='friends'&&!isHost?'disabled':''}>
      <option value="declarer" ${state.settings.pikNoKontra!=='all'?'selected':''}>Refe to declarer (default)</option>
      <option value="all" ${state.settings.pikNoKontra==='all'?'selected':''}>Refe to all eligible players</option>
      </select><p class="muted-note">If no eligible refe can be recorded, the Pik declarer automatically passes. No cards are played.</p></div>
      <p class="muted-note">Any seated player can choose values before starting. Defaults: 100 bula and 2 refe. The game ends when combined bula reaches zero or below.</p></section>
      <div class="lobby-foot">${isHost?button('Start match · Deal the cards','start',{variant:'primary large',disabled:!canStart}):'<p class="text-muted">You are waiting. Take an open seat to play, or watch when the match begins.</p>'}</div>
      ${matchHistory()}</main></div>`;
  }
  // Auction decisions are public. Display each player's highest choice beside
  // their table seat, including Dalje, Igra and suit declarations.
  function auctionChoiceFor(g,seat) {
    if(!g.auction)return null;
    const a=g.auction;
    // Keep each player's HIGHEST bid on the felt even after they say Dalje.
    // "Moje" claims the current contract without raising it, so its value
    // comes from the earlier public bid history, not the later overall bid.
    let currentValue=1,highestValue=0,highest=null,passed=false;
    for(const choice of a.history||[]){
      if((choice.action==='bid'||choice.action==='hand')&&
         Number.isInteger(choice.value))currentValue=choice.value;
      if(choice.seat!==seat)continue;
      if(choice.action==='pass'){passed=true;continue;}
      if(choice.action==='igra'){
        if(!highest)highest={label:'Igra',kind:'igra'};
        continue;
      }
      const value=choice.action==='mogu'?currentValue:choice.value;
      if((choice.action==='bid'||choice.action==='hand'||choice.action==='mogu')&&
         Number.isInteger(value)&&value>highestValue){
        highestValue=value;
        highest=choice.action==='hand'
          ? {label:'Igra '+contractName(value),kind:'igra'}
          : {label:contractName(value),kind:'bid'};
      }
    }
    const declaration=a.igraDeclarations?.find(d=>d.seat===seat);
    if(declaration)return declaration.weaker
      ? {label:'Moja je manja',kind:'weaker'}
      : {label:'Igra '+contractName(declaration.value),kind:'igra'};
    if(highest)return highest;
    // No bid at all: show Dalje only after the player actually passes.
    return passed?{label:'Dalje',kind:'pass'}:null;
  }
  function playerPlace(i,pos) {
    const p=state.players[i],me=i===state.seat;
    const role=state.contract ? (i===state.contract.declarer?'Declarer':state.active.length?state.active.includes(i)?'Defender':'Sitting out':state.follows[i]===false?'Declined':state.follows[i]===true?'Defender':'') : i===state.dealer?'Dealer':'';
    const tricks=state.tricks[i];
    const response=state.followMessages?.[i];
    const responseText=response && i!==state.contract?.declarer ? ` · “${esc(response)}”` : '';
    const auctionChoice=auctionChoiceFor(state,i);
    const declared=Number.isInteger(state.contract?.value);
    // Once the actual game is known, its prominent top-right panel replaces
    // the declarer's old bid badge. Other players keep their highest bid,
    // but in neutral gray because that bid did not win the auction.
    const hideWinningBid=declared&&state.contract.declarer===i;
    const losingBid=declared&&state.contract.declarer!==i;
    // The declarer is the attacker for this hand. Mark only their avatar
    // with an outline; do not highlight the changing card-play turn.
    const attacker=state.contract?.declarer===i;
    return `<div class="seat ${pos} ${attacker?'attacker':''}"><div class="avatar" ${attacker?`title="${esc(nameOf(i))} attacks this hand"`:''}>${esc(p?.name?.charAt(0)?.toUpperCase()||'?')}</div>
      <span class="person">${esc(p?.name||'—')}${me?' (you)':''}</span>
      ${auctionChoice&&!hideWinningBid?`<span class="auction-choice ${auctionChoice.kind}${losingBid?' losing-bid':''}" aria-label="${esc(nameOf(i))} highest bid: ${esc(auctionChoice.label)}">${esc(auctionChoice.label)}</span>`:''}
      <span class="info">${esc(role)}${responseText}${role&&state.contract?' · ':''}${state.contract?`${tricks} trick${tricks!==1?'s':''}`:''}</span>
      ${!me&&state.handCounts[i]?`<div class="mini-backs"><span class="mini-back"></span><span class="mini-back"></span><span class="mini-back"></span><span class="mini-back"></span></div>`:''}</div>`;
  }
  function table(playedCard=null) {
    const me=state.seat??0, left=seats(me+2),right=seats(me+1);
    const cards=state.trick.length?state.trick:state.phase==='trickReview'&&state.lastTrick?state.lastTrick.cards:[];
    const atSeat=seat=>cards.find(p=>p.seat===seat)?.card;
    const status=state.phase==='trickReview'&&state.lastTrick?`${esc(nameOf(state.lastTrick.winner))} takes trick ${state.lastTrick.number}`:
      state.phase==='playing'?`${esc(nameOf(state.turn))} to play`:
      state.contract?`${esc(contractName(state.contract.value,state.contract.hand))}`:'Waiting for bids';
    return `<div class="table-wrap"><div class="felt"><div class="felt-emblem">PREFERANS</div><div class="trick-tag">${state.round?`Round ${state.round} ${state.contract?`· Trick ${Math.min(state.trickNumber+1,10)} / 10`:''}`:''}</div>
      ${playerPlace(left,'left')}${playerPlace(right,'right')}${playerPlace(me,'me')}
      <div class="center-play">${cards.length?[
        {seat:left,position:'pos-left'}, {seat:right,position:'pos-right'}, {seat:me,position:'pos-me'}
      ].filter(p=>atSeat(p.seat)).map(p=>{
        const card=atSeat(p.seat);
        const incoming=playedCard?.seat===p.seat&&playedCard.card===card;
        return `<div class="played ${p.position}${incoming?' incoming':''}">${cardHtml(card,{tiny:true})}</div>`;
      }).join(''):
      ''}</div></div>
      <div class="table-note">${status}${state.multiplier>1?` · ×${state.multiplier} stakes`:''}</div></div>`;
  }
  function hand() {
    if(state.seat===null)return `<section class="my-hand-area"><div class="hand-head"><strong>Spectating</strong></div></section>`;
    const canPlay=state.phase==='playing'&&state.turn===state.seat;
    const canDiscard=state.phase==='discard'&&state.turn===state.seat;
    const valid=new Set(state.legal);
    const cards=state.hands.map((c,i)=>{
      const isSelected=selected.includes(c);
      const newSuit=i===0||state.hands[i-1]?.[0]!==c[0];
      const face=cardHtml(c,{disabled:canPlay?!valid.has(c):false,
        selectable:canDiscard||(canPlay&&valid.has(c)),selectedCard:isSelected});
      return `<div class="hand-card-slot ${isSelected?'is-selected':''} ${newSuit?'suit-start':''}" style="--card-index:${i+1}">${face}</div>`;
    }).join('');
    return `<section class="my-hand-area"><div class="hand-head"><strong>Your hand · ${state.hands.length} cards</strong></div><div class="hand" aria-label="Your playing cards">${cards||'<div class="empty-hand">No cards left</div>'}</div></section>`;
  }
  function contractButtons(list,action,hand=false) {
    return `<div class="button-group">${list.map(c=>button(`${hand?'Igra-':''}${c.n}`,action,{value:c.v,extra:icon(c),variant:c.s?'suit-bid':''})).join('')}</div>`;
  }
  function actionPanel() {
    if(state.seat===null && state.phase!=='summary')return `<div class="actions"><div class="actions-title">Spectating</div>${undoBanner()}</div>`;
    const mine=state.turn===state.seat, s=state;
    let body='';
    if(s.phase==='auction') {
      const a=s.auction;
      const options=s.auctionOptions||{ordinary:null,igra:false,betl:false,sans:false};
      const next=CONTRACTS.find(c=>c.v===options.ordinary);
      const choices=[
        ...(next?[button(next.n,'bid',{value:next.v,extra:icon(next),variant:'suit-bid'})]:[]),
        ...(options.igra?[button('Igra','igra',{variant:'primary'})]:[]),
        ...(options.betl?[button('Igra Betl','hand',{value:6,variant:'igra-betl'})]:[]),
        ...(options.sans?[button('Igra Sans','hand',{value:7,variant:'igra-sans'})]:[])
      ];
      const highest=a.handMode==='suit'?'Igra (suit yet to be declared)':
        a.highSeat===null?'None':contractName(a.bid,a.hand);
      if(!mine)body='<div class="actions-title">'+esc(nameOf(s.turn))+
        ' is bidding</div>';
      else{
        body='<div class="actions-title">Your turn to bid</div><div class="actions-subtitle">'+
          (a.handMode==='suit'?'Someone announced Igra. You may also say Igra; suit contracts are revealed afterward.':
          a.handMode==='betl'?'Igra Betl was declared. Only Igra Sans can beat it.':
          'Ordinary bids advance one contract at a time. Igra enters the suit-game auction; Igra Betl and Igra Sans are declared directly.')+'</div>';
        if(choices.length)body+='<div class="group-label">Available bids</div><div class="auction-bid-line" role="group" aria-label="Available bids">'+choices.join('')+'</div>';
        if(!a.hand && a.highSeat!==null && a.highSeat!==s.seat && a.priority===s.seat)
          body+='<div class="action-row" style="margin-top:9px">'+button('Moje '+a.bid,'mogu',{variant:'active'})+'</div>';
        body+='<div class="pass-row">'+button('Dalje','pass',{variant:'pass-action'})+'</div>';
      }
      body='<div class="bid-status">Current: '+esc(highest)+'</div>'+body;
    } else if(s.phase==='igraReveal') {
      const a=s.auction;
      const declarations=a.igraDeclarations||[];
      const claimants=a.igraPlayers||[];
      const highest=declarations.filter(d=>Number.isInteger(d.value))
        .reduce((best,d)=>Math.max(best,d.value),0);
      const firstClaimant=claimants[0]===s.seat;
      const allowed=CONTRACTS.filter(c=>c.v>=2&&c.v<=5&&(firstClaimant||c.v>2));
      body='<div class="actions-title">'+(mine?'Declare your Igra suit game':esc(nameOf(s.turn))+' is declaring Igra')+
        '</div><div class="actions-subtitle">Igra claimants declare their suit games directly. The highest game wins and the earlier claimant wins a tie. Only the first Igra claimant may declare Pik; later players can concede a weaker suit without revealing it.</div>'+
        '<div class="group-label">Igra players</div><div class="igra-claims">'+
        claimants.map(seat=>{
          const declared=declarations.find(d=>d.seat===seat);
          const answer=declared?(declared.weaker?'My game is weaker':contractName(declared.value)):'Choosing…';
          return '<span class="igra-claim">'+esc(nameOf(seat))+' · '+esc(answer)+'</span>';
        }).join('')+'</div>'+
        (mine?'<div class="group-label">My Igra is</div><div class="auction-bid-line" role="group" aria-label="Declare suit Igra">'+
          allowed.map(c=>button(c.n,'igraDeclare',{value:c.v,extra:icon(c),variant:'suit-bid'})).join('')+
          (highest>=2?button('Moja je manja · Weaker','igraWeaker',{variant:'subtle'}):'')+'</div>':'');
    } else if(s.phase==='talon') {
      body=`<div class="actions-title">The talon is revealed</div><div class="actions-subtitle">${esc(nameOf(s.contract.declarer))} won at ${s.contract.minimum}. Two cards are shown publicly before being added to the declarer's hand.</div>
        <div class="talon-preview">${s.talon.map(c=>cardHtml(c,{tiny:true})).join('')}</div>${mine?button('Take the talon','takeTalon',{variant:'primary'}):'<span class="text-muted">Waiting for declarer to take the talon.</span>'}`;
    } else if(s.phase==='discard') {
      body=`<div class="actions-title">${mine?'Set aside two cards':`${esc(nameOf(s.turn))} is discarding`}</div>
        <div class="actions-subtitle">The chosen cards stay hidden. You will then select a contract at or above the winning bid.</div>
        ${mine?button(`Discard ${selected.length} of 2 cards`,'discard',{variant:'primary',disabled:selected.length!==2}):''}`;
    } else if(s.phase==='contract') {
      body=`<div class="actions-title">${mine?'Declare your contract':`${esc(nameOf(s.turn))} is choosing a contract`}</div><div class="actions-subtitle">Choose the game you won in the auction or any stronger one.</div>
      ${mine?contractButtons(CONTRACTS.filter(c=>c.v>=s.contract.minimum),'declare'):''}`;
    } else if(s.phase==='following') {
      body=`${mine?'':`<div class="actions-title">${esc(nameOf(s.turn))} decides whether to defend</div>`}
      ${mine?`<div class="action-row">${button('Dođem','followYes',{variant:'primary'})}${button('Ne','followNo')}${button('Ne bi','followRatherNot')}${button('Imam želju','followWish')}</div>`:''}`;
    } else if(s.phase==='calling') {
      body=`<div class="actions-title">${mine?'Invite the other defender?':`${esc(nameOf(s.turn))} decides whether to invite a partner`}</div>
      <div class="actions-subtitle">Inviting brings the other defender into the tricks. The invited player earns no points and cannot say Kontra. You receive the combined defenders' supe but need at least four tricks together.</div>
      ${mine?`<div class="action-row">${button('Idemo zajedno · Invite','callYes',{variant:'primary'})}${button('Defend alone','callNo')}</div>`:''}`;
    } else if(s.phase==='doubles') {
      const labels=['Kontra','Rekontra','Subkontra'];
      const stage=s.doubleStage;
      body=`${mine?'':`<div class="actions-title">${esc(nameOf(s.turn))} decides the stakes</div>`}
        ${mine?`<div class="action-row">${button('Može','doubleOk')}${s.availableDoubles?.includes(['kontra','rekontra','subkontra'][stage])?button(labels[stage],'doubleRaise',{variant:'primary'}):''}</div>`:''}`;
    } else if(s.phase==='playing') {
      body=`<div class="actions-title">${mine?'Your turn — play one card':`${esc(nameOf(s.turn))} is playing`}</div><div class="actions-subtitle">${mine?'You must follow the led suit if possible, or play trump if void in a trump contract. Only legal cards can be selected.':'Follow suit, trump when void in trump games, and capture tricks to meet your contract.'}</div>`;
    } else if(s.phase==='trickReview') {
      body=`<div class="actions-title">${esc(nameOf(s.lastTrick?.winner))} wins trick ${s.trickNumber}</div><div class="actions-subtitle">The winner leads the next trick. The board will continue automatically.</div>`;
    } else if(s.phase==='summary') {
      const x=s.summary;
      body=`<div class="result-summary"><h3>${esc(x?.title)}</h3><p>${esc(x?.details)}</p></div>`;
      if(x?.kind==='played') body+=`<div class="result-grid">${s.players.map((p,i)=>`<div class="result-item"><strong>${esc(p?.name)}</strong><span>Tricks · ${x.tricks[i]}</span><span>Bula ${x.scoreChanges[i]>=0?'+':''}${x.scoreChanges[i]}</span><b class="${x.scoreChanges[i]<0?'good':x.scoreChanges[i]>0?'bad':''}">Supa +${x.supaChanges[i]}</b></div>`).join('')}</div>`;
      if(s.finished) {
        const standings=s.finalScores.map((score,i)=>({i,score})).sort((a,b)=>a.score-b.score);
        body+=`<div class="winning-banner">Match finished! ${esc(nameOf(standings[0].i))} has the lowest final score (${standings[0].score}).</div><div class="action-row" style="margin-top:17px">${button(s.mode==='solo'?'Play a new practice match':'Set up next match','newMatch',{variant:'primary large'})}</div>`;
      } else if(s.settlementRequest){
        const req=s.settlementRequest,approvals=req.approvals.filter(Boolean).length;
        const canVote=s.seat!==null&&s.seat!==req.seat&&!req.approvals[s.seat];
        body+=`<div class="settlement-notice"><strong>Otpisivanje · ${esc(nameOf(req.seat))} proposes ending the match</strong>
          <p>${approvals}/3 players approved. All bula will be adjusted to total zero, while supa stays unchanged. The next deal is paused until the vote ends.</p>
          ${canVote?`<div class="action-row">${button('Agree to end match','settleYes',{variant:'primary'})}${button('Keep playing','settleNo',{variant:'subtle'})}</div>`:
          '<p>Waiting for the remaining votes or the 30-second timeout.</p>'}</div>`;
      } else {
        body+=s.seat===null?'<p class="muted-note">Waiting for the players to deal the next round.</p>':button('Deal next round','nextRound',{variant:'primary large'});
        if(s.canSettle)body+=`<div class="settlement-offer"><p class="muted-note">Finish this match by otpisivanje: subtract bula equally (rounding any extra toward the highest bula), preserving supa. Both other players must approve.</p>
          ${button('End match by agreement · Otpisivanje','requestSettlement',{variant:'subtle'})}</div>`;
      }
    }
    // Keep the playable actions and essential status; discard long how-to text.
    body=body.replace(/<div class="actions-subtitle">[\s\S]*?<\/div>/g,'');
    return `<div class="actions">${s.undoRequest?undoBanner():body}${!s.undoRequest?undoBanner():''}</div>`;
  }
  function sidebar() {
    const g=state;
    return `<aside class="side-stack"><div class="panel panel-pad"><span class="eyebrow">Live scorecard</span><h3 class="side-title">The scores</h3>
      <table class="score-table live-score-table" aria-label="Live Preferans scores and adjusted standings"><thead><tr><th>Player</th><th>Bula</th><th>Refe</th><th>Final</th><th title="Current final score minus one third of combined remaining bula × 10; negative is ahead">Adjusted</th></tr></thead><tbody>
      ${g.players.map((p,i)=>{
        const adjusted=g.projectedScores?.[i]??0;
        return `<tr class="${i===g.seat?'own':''} ${g.finalScores[i]===Math.min(...g.finalScores)?'leader-row':''}"><td><i class="tiny-online ${p?.online?'':'off'}"></i>${esc(p?.name||'—')} ${g.finalScores[i]===Math.min(...g.finalScores)?'★':''}</td>
        <td class="number ${g.scores.bula[i]<0?'good':''}">${g.scores.bula[i]}</td><td>${g.scores.refe[i]}</td><td class="number ${g.finalScores[i]<0?'good':'bad'}">${g.finalScores[i]}</td><td class="number adjusted-score ${adjusted<0?'good':adjusted>0?'bad':''}">${adjusted>0?'+':''}${adjusted}</td></tr>`;
      }).join('')}</tbody></table>
      <div class="score-mini"><span>Combined bula remaining</span><strong>${g.scores.bula.reduce((n,x)=>n+x,0)}</strong></div>
      <div class="soft-divider"></div><div class="group-label">Supa ledger · row scores against column</div>
      <table class="supa-ledger"><thead><tr><th>From \ Against</th>${g.players.map(p=>`<th>${esc((p?.name||'?').slice(0,8))}</th>`).join('')}</tr></thead><tbody>
      ${g.scores.supe.map((row,i)=>`<tr><td>${esc(nameOf(i).slice(0,11))}</td>${row.map((n,j)=>`<td>${i===j?'—':n}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="panel panel-pad"><span class="eyebrow">Table history</span><h3 class="side-title">Recent actions</h3><ul class="log">${[...g.log].reverse().map(s=>`<li>${esc(s)}</li>`).join('')||'<li>Waiting for the first deal.</li>'}</ul></div>
      ${matchHistory()}</aside>`;
  }
  function contractCorner(g) {
    const declared=Number.isInteger(g.contract?.value);
    const hasMinimum=Number.isInteger(g.contract?.minimum);
    const value=declared?g.contract.value:hasMinimum?g.contract.minimum:null;
    const contract=CONTRACTS.find(c=>c.v===value);
    const label=declared?'Current game':hasMinimum?'Winning bid':'Auction';
    const name=declared?contractName(value,g.contract.hand):hasMinimum?contractName(value):'Bidding';
    const suit=contract?.s?SUITS[contract.s]:'';
    const red=contract?.s==='D'||contract?.s==='H';
    return `<div class="phase-tag ${declared?'current-contract':''}" aria-label="${esc(label+': '+name)}">
      <span class="phase-tag-caption">${esc(label)}</span>
      <span class="phase-tag-main">${suit?`<span class="phase-tag-suit ${red?'red':''}" aria-hidden="true">${suit}</span>`:''}<strong>${esc(name)}</strong></span>
    </div>`;
  }
  function gameScreen(playedCard=null) {
    const subtitle=state.seat===null?'Watching · waiting to play':state.turn===null?'Waiting for the next step':`${nameOf(state.turn)}${state.turn===state.seat?' (you)':''} to act`;
    // Keep actions near the thumb on phones when it is this player's turn.
    // During other turns, results and card play, keep the normal document flow.
    const mobileDock=state.seat!==null && state.turn===state.seat &&
      ['auction','igraReveal','talon','discard','contract','following','calling','doubles'].includes(state.phase);
    return `<div class="app">${header()}<div class="layout"><main class="main-col"><section class="panel game-stage${mobileDock?' has-mobile-dock':''}" data-phase="${esc(state.phase)}">
      <div class="stage-header"><div><span class="eyebrow">Round ${state.round} · Dealer: ${esc(nameOf(state.dealer))}</span><h2>${phaseTitle[state.phase]}</h2><p>${esc(subtitle)}</p></div>${contractCorner(state)}</div>
      ${table(playedCard)}${hand()}${actionPanel()}</section>
      ${state.lastTrick?`<div class="last-trick"><small>Last trick · ${esc(nameOf(state.lastTrick.winner))} won:</small>${state.lastTrick.cards.map(p=>cardHtml(p.card)).join('')}</div>`:''}
      </main>${sidebar()}</div></div>`;
  }
  function render(playedCard=null){
    if(!root)return;
    root.innerHTML=state?(state.phase==='lobby'?lobby():gameScreen(playedCard)):welcome();
  }
  function action(a,value) {
    if(!connected){toast('Connection lost — reconnecting.');return;}
    const send=(event,data={})=>socket.emit(event,data);
    switch(a){
      case 'startSolo':{
        const name=state?.myName||$('#player-name')?.value?.trim()||localStorage.getItem('pref3:lastName')||'Player';
        if(name.length<1||name.length>24){sayError('Enter a name (1–24 characters).');return;}
        localStorage.setItem('pref3:lastName',name);
        emitAck('joinSolo',{name});return;
      }
      case 'exitSolo':{
        socket.emit('exitSolo',{},answer=>{
          if(!answer?.ok){sayError(answer?.error||'Could not exit practice.');return;}
          localStorage.removeItem(SOLO_KEY);
          session=null;state=null;
          localStorage.setItem(MODE_KEY,'friends');
          reconnect('friends');render();
        });
        return;
      }
      case 'restartSolo':{
        if(!confirm('Restart practice? Current cards and practice scores will reset.'))return;
        socket.emit('restartSolo',{},answer=>{if(!answer?.ok)sayError(answer?.error||'Cannot restart practice.');});
        return;
      }
      case 'share':{
        const url=`${location.origin}/`;
        if(navigator.clipboard?.writeText)navigator.clipboard.writeText(url).then(()=>toast('Invitation link copied!')).catch(()=>window.prompt('Copy this invitation link:',url));
        else window.prompt('Copy this invitation link:',url);
        return;
      }
      case 'takeSeat':case 'sitOut':case 'removeOffline':case 'newMatch':case 'leaveTable':{
        if(a==='leaveTable'&&!confirm('Leave the shared group? You can rejoin later if a place is free.'))return;
        socket.emit(a,a==='removeOffline'?{memberId:Number(value)}:{},answer=>{
          if(!answer?.ok){sayError(answer?.error||'Could not update the table.');return;}
          if(a==='leaveTable'){
            state=null;session=null;localStorage.removeItem(SESSION_KEY);render();
          }
        });
        return;
      }
      case 'requestSettlement':case 'settleYes':case 'settleNo':{
        if(a==='requestSettlement'&&!confirm('Ask both other players to end this match by otpisivanje? The remaining bula will be settled to zero and the result saved.'))return;
        const event=a==='requestSettlement'?'requestSettlement':'voteSettlement';
        const payload=a==='requestSettlement'?{}:{approve:a==='settleYes'};
        socket.emit(event,payload,answer=>{if(!answer?.ok)toast(answer?.error||'The settlement vote could not be completed.');});
        return;
      }
      case 'requestUndo':case 'approveUndo':case 'rejectUndo':{
        const event=a==='requestUndo'?'requestUndo':'voteUndo';
        const payload=a==='requestUndo'?{}:{approve:a==='approveUndo'};
        socket.emit(event,payload,answer=>{if(!answer?.ok)toast(answer?.error||'Undo could not be completed.');});
        return;
      }
      case 'exportHistory':{
        const records=state.history||[];
        const json=JSON.stringify({version:1,records},null,2);
        const blob=new Blob([json],{type:'application/json'});
        const url=URL.createObjectURL(blob),a=document.createElement('a');
        a.href=url;a.download='preferans-results-backup.json';a.click();
        setTimeout(()=>URL.revokeObjectURL(url),1000);
        return;
      }
      case 'importHistory':{
        const adminSecret=window.prompt('Administrator password required to import results:');
        if(!adminSecret)return;
        if(!confirm('Import this saved backup into the current leaderboard?'))return;
        const file=document.createElement('input');file.type='file';file.accept='.json,application/json';
        file.onchange=async()=>{
          try{
            if(!file.files?.[0])return;
            const data=JSON.parse(await file.files[0].text()),records=Array.isArray(data)?data:data.records;
            if(!Array.isArray(records)||records.length>200)throw Error('Backup must contain at most 200 games.');
            socket.emit('restoreHistory',{records,adminSecret},answer=>{
              if(!answer?.ok)toast(answer?.error||'Backup could not be restored.');
              else toast('Score records imported.');
            });
          }catch(e){toast(e.message||'Invalid backup file.');}
        };
        file.click();return;
      }
      case 'resetScores':{
        const adminSecret=window.prompt('Administrator password to PERMANENTLY delete all saved match scores:');
        if(!adminSecret)return;
        const confirmation=window.prompt('This deletes all saved match history, totals and wins. Type RESET ALL SCORES to confirm:');
        if(confirmation!=='RESET ALL SCORES'){toast('Reset cancelled.');return;}
        socket.emit('resetScores',{adminSecret,confirmation},answer=>{
          if(!answer?.ok){toast(answer?.error||'Could not reset scores.');return;}
          try{localStorage.removeItem(HISTORY_KEY);}catch{}
          toast('Saved scores and leaderboard were cleared.');
        });
        return;
      }
      case 'start':send('start');return;
      case 'nextRound':selected=[];send('nextRound');return;
      case 'pass':send('bid',{action:'pass'});return;
      case 'bid':send('bid',{action:'bid',value:Number(value)});return;
      case 'mogu':send('bid',{action:'mogu'});return;
      case 'igra':send('bid',{action:'igra'});return;
      case 'hand':send('bid',{action:'hand',value:Number(value)});return;
      case 'igraDeclare':send('igraDeclare',{value:Number(value)});return;
      case 'igraWeaker':send('igraDeclare',{value:'weaker'});return;
      case 'takeTalon':send('takeTalon');return;
      case 'discard':send('discard',{cards:selected});selected=[];return;
      case 'declare':send('declare',{value:Number(value)});return;
      case 'followYes':send('follow',{choice:'dodjem'});return;
      case 'followNo':send('follow',{choice:'ne'});return;
      case 'followWish':send('follow',{choice:'imam-zelju'});return;
      case 'followRatherNot':send('follow',{choice:'ne-bi'});return;
      case 'callYes':send('call',{yes:true});return;
      case 'callNo':send('call',{yes:false});return;
      case 'doubleOk':send('double',{action:'ok'});return;
      case 'doubleRaise':send('double',{action:['kontra','rekontra','subkontra'][state.doubleStage]});return;
    }
  }
  root.addEventListener('click',ev=>{
    const b=ev.target.closest('[data-action]');
    if(b){if(!b.disabled)action(b.dataset.action,b.dataset.value);return;}
    const c=ev.target.closest('[data-card]');
    if(!c||!state)return;
    const card=c.dataset.card;
    if(state.phase==='discard'){
      if(selected.includes(card))selected=selected.filter(x=>x!==card);
      else if(selected.length<2)selected.push(card);
      render();
    } else if(state.phase==='playing'&&state.turn===state.seat&&state.legal.includes(card)) socket.emit('play',{card});
  });
  root.addEventListener('keydown',ev=>{
    if((ev.key==='Enter'||ev.key===' ')&&ev.target.matches('[data-card]')){ev.preventDefault();ev.target.click();}
  });
  root.addEventListener('submit',ev=>{
    if(ev.target.id!=='join-form')return;
    ev.preventDefault();
    const form=new FormData(ev.target),name=String(form.get('name')||'').trim();
    if(!name){sayError('Enter your name.');return;}
    localStorage.setItem('pref3:lastName',name);
    emitAck('joinTable',{name});
  });
  root.addEventListener('change',ev=>{
    if(!ev.target.matches('[data-settings]')||!state||state.seat===null)return;
    const startBula=Number($('#start-bula')?.value),maxRefe=Number($('#max-refe')?.value);
    const pikNoKontra=$('#pik-no-kontra')?.value||'declarer';
    socket.emit('settings',{startBula,maxRefe,pikNoKontra});
  });
  render();
})();
