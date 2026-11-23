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
  const phaseTitle = {lobby:'Waiting for players',auction:'The auction',talon:'The talon',discard:'Discard two cards',contract:'Choose your contract',following:'Defenders decide',calling:'Invite a partner',doubles:'Kontra & raises',playing:'Trick-taking',trickReview:'Trick complete',summary:'Round results'};
  const contractName = (v,hand=false) => `${hand?'Igra-':''}${CONTRACTS.find(c=>c.v===v)?.n||'?'}`;
  const seatLabel = i => i===state.seat?'You':nameOf(i);
  const SESSION_KEY='pref3:friends';
  function rememberSession(data) {
    session={token:data.token};
    localStorage.setItem(SESSION_KEY,JSON.stringify(session));
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
      alertText='';rememberSession(result);callback?.(true);render();
    });
  }
  function reconnect() {
    let saved=session;
    if(!saved){try{saved=JSON.parse(localStorage.getItem(SESSION_KEY));}catch{}}
    if(!saved?.token)return;
    socket.emit('joinTable',{token:saved.token},answer=>{
      if(answer?.ok){rememberSession(answer);alertText='';render();}
      else {
        state=null;session=null;localStorage.removeItem(SESSION_KEY);
        alertText='Your previous session is no longer available. Enter your name to join the shared table.';render();
      }
    });
  }
  socket.on('connect',()=>{connected=true;reconnect();render();});
  socket.on('disconnect',()=>{connected=false;render();});
  socket.on('leftTable',()=>{state=null;session=null;localStorage.removeItem(SESSION_KEY);render();});
  socket.on('state',g=>{state=g;selected=selected.filter(c=>g.hands.includes(c));render();});
  socket.on('actionError',message=>sayError(message));

  const icon = c => `<span class="suit-symbol ${['D','H'].includes(c.s)?'red':''}">${c.s?SUITS[c.s]:''}</span>`;
  function cardHtml(c,{tiny=false,disabled=false,selectable=false,selectedCard=false}={}) {
    if(!c)return `<div class="playing-card back ${tiny?'tiny':''}" aria-label="Face-down card"><span class="back-emblem">♠</span></div>`;
    const suit=c[0],rank=c.slice(1),symbol=SUITS[suit];
    const red=suit==='D'||suit==='H';
    const rankLabel={J:'Jack',Q:'Queen',K:'King',A:'Ace'}[rank]||rank;
    const suitLabel={S:'Spades',D:'Diamonds',C:'Clubs',H:'Hearts'}[suit];
    return `<div class="playing-card ${tiny?'tiny':''} ${red?'red':'black'} ${disabled?'disabled':''} ${selectedCard?'selected':''}" ${selectable?`data-card="${esc(c)}" role="button" tabindex="0" aria-label="${rankLabel} of ${suitLabel}"`:''}>
      <span class="card-corner"><b>${esc(rank)}</b><small>${symbol}</small></span>
      <span class="card-center" aria-hidden="true"><span class="suit-big">${symbol}</span><span class="court-flourish">${['J','Q','K','A'].includes(rank)?'✦':''}</span></span>
      <span class="card-corner mirrored" aria-hidden="true"><b>${esc(rank)}</b><small>${symbol}</small></span></div>`;
  }
  function button(title,action,opts={}) {
    const {value,variant='',disabled=false,extra=''}=opts;
    return `<button type="button" class="button ${variant}" data-action="${action}" ${value!==undefined?`data-value="${esc(value)}"`:''} ${disabled?'disabled':''}>${extra}${esc(title)}</button>`;
  }
  function header() {
    return `<header class="topbar"><div class="brand"><span class="brandmark">♠</span><div><h1>Preferans</h1><small>Private card table</small></div></div>
    <div class="top-actions"><span class="pill"><i class="online-dot ${connected?'':'off'}"></i>${connected?'Connected':'Reconnecting'}</span>
    ${state?button('Copy table link','share',{variant:'small'}):''}</div></header>`;
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
      </div>
      </section></div>`;
  }
  function lobby() {
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
      <p class="muted-note">Any seated player can choose values before starting. Defaults: 100 bula and 2 refe. The game ends when combined bula reaches zero or below.</p></section>
      <div class="lobby-foot">${isHost?button('Start match · Deal the cards','start',{variant:'primary large',disabled:!canStart}):'<p class="text-muted">You are waiting. Take an open seat to play, or watch when the match begins.</p>'}</div>
      </main></div>`;
  }
  function playerPlace(i,pos) {
    const p=state.players[i],turn=state.turn===i, me=i===state.seat;
    const role=state.contract ? (i===state.contract.declarer?'Declarer':state.active.length?state.active.includes(i)?'Defender':'Sitting out':state.follows[i]===false?'Declined':state.follows[i]===true?'Defender':'') : i===state.dealer?'Dealer':'';
    const tricks=state.tricks[i];
    const response=state.followMessages?.[i];
    const responseText=response && i!==state.contract?.declarer ? ` · “${esc(response)}”` : '';
    return `<div class="seat ${pos} ${turn?'current':''}"><div class="avatar">${esc(p?.name?.charAt(0)?.toUpperCase()||'?')}</div>
      <span class="person">${esc(p?.name||'—')}${me?' (you)':''}</span><span class="info">${esc(role)}${responseText}${role&&state.contract?' · ':''}${state.contract?`${tricks} trick${tricks!==1?'s':''}`:''}</span>
      ${!me&&state.handCounts[i]?`<div class="mini-backs"><span class="mini-back"></span><span class="mini-back"></span><span class="mini-back"></span><span class="mini-back"></span></div>`:''}</div>`;
  }
  function table() {
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
      ].filter(p=>atSeat(p.seat)).map(p=>`<div class="played ${p.position}">${cardHtml(atSeat(p.seat),{tiny:true})}</div>`).join(''):
      `<div class="felt-hint">${state.phase==='trickReview'?'Preparing next trick…':state.contract?esc(contractName(state.contract.value,state.contract.hand)):'Bid to begin the round'}</div>`}</div></div>
      <div class="table-note">${status}${state.multiplier>1?` · ×${state.multiplier} stakes`:''}</div></div>`;
  }
  function hand() {
    if(state.seat===null)return `<section class="my-hand-area"><div class="hand-head"><strong>Watching as ${esc(state.myName)}</strong></div><p class="muted-note">You can watch public tricks and scores. Players' private cards remain hidden.</p></section>`;
    const canPlay=state.phase==='playing'&&state.turn===state.seat;
    const canDiscard=state.phase==='discard'&&state.turn===state.seat;
    const valid=new Set(state.legal);
    const cards=state.hands.map(c=>cardHtml(c,{disabled:canPlay?!valid.has(c):false,selectable:canDiscard||(canPlay&&valid.has(c)),selectedCard:selected.includes(c)})).join('');
    const hint=canDiscard?'Select exactly two cards to set aside privately.':canPlay?'Choose a highlighted playable card.':'Your cards stay private from other players.';
    return `<section class="my-hand-area"><div class="hand-head"><strong>Your hand · ${state.hands.length} cards</strong><span>${esc(hint)}</span></div><div class="hand">${cards||'<div class="empty-hand">Your cards have all been played.</div>'}</div></section>`;
  }
  function contractButtons(list,action,hand=false) {
    return `<div class="button-group">${list.map(c=>button(`${hand?'Igra-':''}${c.n}`,action,{value:c.v,extra:icon(c)})).join('')}</div>`;
  }
  function actionPanel() {
    if(state.seat===null && state.phase!=='summary')return `<div class="actions"><div class="actions-title">Waiting for the next match</div><div class="actions-subtitle">Enjoy watching! Three players are at the table. You can take a seat before the next match starts.</div></div>`;
    const mine=state.turn===state.seat, s=state;
    let body='';
    if(s.phase==='auction') {
      const a=s.auction;
      if(!mine) body=`<div class="actions-title">${esc(nameOf(s.turn))} is bidding</div><div class="actions-subtitle">Highest bid: ${a.highSeat===null?'None':`${contractName(a.bid,a.hand)} by ${nameOf(a.highSeat)}`}. ${a.priority!==null?`${esc(nameOf(a.priority))} has Mogu priority.`:''}</div>`;
      else {
        body=`<div class="actions-title">Your turn to bid</div><div class="actions-subtitle">${a.hand?`A hand declaration (${contractName(a.handValue,true)}) is on the table. Only a stronger hand declaration can beat it.`:`Current bid: ${a.highSeat===null?'None':`${contractName(a.bid)} — ${esc(nameOf(a.highSeat))}`}. Bid higher, say Mogu if you have priority, or pass.`}</div>`;
        if(!a.hand && a.bid<7) body+=`<div class="group-label">Standard bid</div>${contractButtons(CONTRACTS.filter(c=>c.v>a.bid),'bid')}`;
        if(!a.hand&&a.highSeat!==null&&a.highSeat!==s.seat&&a.priority===s.seat) body+=`<div class="action-row" style="margin-top:9px">${button(`Mogu ${a.bid}`,'mogu',{variant:'active'})}</div>`;
        if(a.handValue!==7) body+=`<div class="group-label">Declare from hand · skip talon · +1 game value</div>${contractButtons(CONTRACTS.filter(c=>!a.hand||c.v>a.handValue),'hand',true)}`;
        body+=`<div class="soft-divider"></div>${button('Dalje · Pass','pass',{variant:'subtle'})}`;
      }
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
      body=`<div class="actions-title">${mine?'Will you defend?':`${esc(nameOf(s.turn))} decides whether to defend`}</div><div class="actions-subtitle">The declarer needs at least six tricks. You may join the defense or sit out. Only participating defenders score supe.</div>
      ${mine?`<div class="action-row">${button('Dođem','followYes',{variant:'primary'})}${button('Ne','followNo')}${button('Ne bi','followRatherNot')}</div>`:''}`;
    } else if(s.phase==='calling') {
      body=`<div class="actions-title">${mine?'Invite the other defender?':`${esc(nameOf(s.turn))} decides whether to invite a partner`}</div>
      <div class="actions-subtitle">Inviting brings the other defender into the tricks. You receive both defenders' supe but need at least four tricks combined.</div>
      ${mine?`<div class="action-row">${button('Idemo zajedno · Invite','callYes',{variant:'primary'})}${button('Defend alone','callNo')}</div>`:''}`;
    } else if(s.phase==='doubles') {
      const labels=['Kontra','Rekontra','Subkontra'];
      const stage=s.doubleStage;
      body=`<div class="actions-title">${mine?'Raise the stakes?':`${esc(nameOf(s.turn))} decides the stakes`}</div>
        <div class="actions-subtitle">Current multiplier ×${s.multiplier}. ${stage===0?'Each defender may give Kontra; plain Pik requires it to be played.':'Each new counter doubles all bula and supa changes. The defender giving Kontra takes sole scoring responsibility.'}</div>
        ${mine?`<div class="action-row">${button('Moze · Accept','doubleOk')}${stage===0&&s.follows[s.seat]===false?'':button(labels[stage],'doubleRaise',{variant:'primary'})}</div>`:''}`;
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
        body+=`<div class="winning-banner">Match finished! ${esc(nameOf(standings[0].i))} has the lowest final score (${standings[0].score}).</div><div class="action-row" style="margin-top:17px">${button('Set up next match','newMatch',{variant:'primary large'})}</div>`;
      } else body+=s.seat===null?'<p class="muted-note">Waiting for the players to deal the next round.</p>':button('Deal next round','nextRound',{variant:'primary large'});
    }
    return `<div class="actions">${body}</div>`;
  }
  function sidebar() {
    const g=state;
    return `<aside class="side-stack"><div class="panel panel-pad"><span class="eyebrow">Live scorecard</span><h3 class="side-title">The scores</h3>
      <table class="score-table"><thead><tr><th>Player</th><th>Bula</th><th>Refe</th><th>Final</th></tr></thead><tbody>
      ${g.players.map((p,i)=>`<tr class="${i===g.seat?'own':''}"><td><i class="tiny-online ${p?.online?'':'off'}"></i>${esc(p?.name||'—')}</td>
      <td class="number ${g.scores.bula[i]<0?'good':''}">${g.scores.bula[i]}</td><td>${g.scores.refe[i]}</td><td class="number ${g.finalScores[i]<0?'good':'bad'}">${g.finalScores[i]}</td></tr>`).join('')}</tbody></table>
      <div class="score-mini"><span>Combined bula remaining</span><strong>${g.scores.bula.reduce((n,x)=>n+x,0)}</strong></div>
      <p class="score-key">Lower final scores are better. Final = 10 × bula + supe owed to opponents − supe earned against them. A refe doubles your next played contract.</p>
      <div class="soft-divider"></div><div class="group-label">Supa ledger · row scores against column</div>
      <table class="supa-ledger"><thead><tr><th>From \ Against</th>${g.players.map(p=>`<th>${esc((p?.name||'?').slice(0,8))}</th>`).join('')}</tr></thead><tbody>
      ${g.scores.supe.map((row,i)=>`<tr><td>${esc(nameOf(i).slice(0,11))}</td>${row.map((n,j)=>`<td>${i===j?'—':n}</td>`).join('')}</tr>`).join('')}</tbody></table></div>
      <div class="panel panel-pad"><span class="eyebrow">Table history</span><h3 class="side-title">Recent actions</h3><ul class="log">${[...g.log].reverse().map(s=>`<li>${esc(s)}</li>`).join('')||'<li>Waiting for the first deal.</li>'}</ul></div>
      <div class="panel panel-pad rules-link"><span class="eyebrow">Playing rules</span><h3 class="side-title">Need a refresher?</h3>
        This game follows the <a href="https://www.preferansklub.com/pravila1.htm" target="_blank" rel="noopener noreferrer">Preferans Klub rules</a>, including Mogu, Betl, Sans, Kontra, and the bula/supa scorecard. The app is for three humans; no bots are needed.
      </div></aside>`;
  }
  function gameScreen() {
    const subtitle=state.seat===null?'Watching · waiting to play':state.turn===null?'Waiting for the next step':`${nameOf(state.turn)}${state.turn===state.seat?' (you)':''} to act`;
    return `<div class="app">${header()}<div class="layout"><main class="main-col"><section class="panel">
      <div class="stage-header"><div><span class="eyebrow">Round ${state.round} · Dealer: ${esc(nameOf(state.dealer))}</span><h2>${phaseTitle[state.phase]}</h2><p>${esc(subtitle)}</p></div><span class="phase-tag">${state.contract?contractName(state.contract.value,state.contract.hand):'Bidding'}</span></div>
      ${table()}${hand()}${actionPanel()}</section>
      ${state.lastTrick?`<div class="last-trick"><small>Last trick · ${esc(nameOf(state.lastTrick.winner))} won:</small>${state.lastTrick.cards.map(p=>cardHtml(p.card)).join('')}</div>`:''}
      </main>${sidebar()}</div></div>`;
  }
  function render(){
    if(!root)return;
    root.innerHTML=state?(state.phase==='lobby'?lobby():gameScreen()):welcome();
  }
  function action(a,value) {
    if(!connected){toast('Connection lost — reconnecting.');return;}
    const send=(event,data={})=>socket.emit(event,data);
    switch(a){
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
      case 'start':send('start');return;
      case 'nextRound':selected=[];send('nextRound');return;
      case 'pass':send('bid',{action:'pass'});return;
      case 'bid':send('bid',{action:'bid',value:Number(value)});return;
      case 'mogu':send('bid',{action:'mogu'});return;
      case 'hand':send('bid',{action:'hand',value:Number(value)});return;
      case 'takeTalon':send('takeTalon');return;
      case 'discard':send('discard',{cards:selected});selected=[];return;
      case 'declare':send('declare',{value:Number(value)});return;
      case 'followYes':send('follow',{choice:'dodjem'});return;
      case 'followNo':send('follow',{choice:'ne'});return;
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
    socket.emit('settings',{startBula,maxRefe});
  });
  render();
})();
