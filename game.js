/** Rule engine. All actions are validated server-side; never trust a client's cards or phase. */
import { randomInt } from 'node:crypto';

export const SUITS = ['S', 'D', 'H', 'C']; // Pik, Karo, Herc, Tref
export const RANKS = ['7', '8', '9', '10', 'J', 'Q', 'K', 'A'];
export const CONTRACTS = [
  { value: 2, name: 'Pik', suit: 'S' },
  { value: 3, name: 'Karo', suit: 'D' },
  { value: 4, name: 'Herc', suit: 'H' },
  { value: 5, name: 'Tref', suit: 'C' },
  { value: 6, name: 'Betl', suit: null },
  { value: 7, name: 'Sans', suit: null }
];
const mod = n => (n + 3) % 3;
const next = n => mod(n + 1);
const otherSeats = seat => [next(seat), mod(seat + 2)];
const bad = message => { throw new Error(message); };
const assert = (condition, message) => { if (!condition) bad(message); };
const isInt = n => Number.isInteger(n);
const suit = c => c[0];
const rank = c => RANKS.indexOf(c.slice(1));
const contractName = (v, hand = false) => `${hand ? 'Igra-' : ''}${CONTRACTS.find(x => x.value === v)?.name || '?'}`;
// Display order: group each suit and keep ranks ascending from 7 to Ace.
// Pik -> Karo -> Tref -> Herc keeps the two red suits apart.
// If Tref is absent, put Pik between Karo and Herc whenever possible.
// Suit order does not affect trick-taking rules or the bid order.
export function sortHand(hand) {
  const has = new Set(hand.map(card => suit(card)));
  const order = has.has('D') && has.has('H') && !has.has('C') && has.has('S')
    ? ['D', 'S', 'H', 'C']
    : ['S', 'D', 'C', 'H'];
  const position = new Map(order.map((s, i) => [s, i]));
  return hand.sort((a, b) => position.get(suit(a)) - position.get(suit(b)) || rank(a) - rank(b));
}

export function makeDeck() { return SUITS.flatMap(s => RANKS.map(r => s + r)); }
export function shuffle(deck) {
  const cards = [...deck];
  for (let i = cards.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}
export function createGame(settings = {}) {
  const startBula = Number.isInteger(+settings.startBula) && +settings.startBula >= 50 && +settings.startBula <= 120 ? +settings.startBula : 100;
  const maxRefe = [2,3,4].includes(+settings.maxRefe) ? +settings.maxRefe : 2;
  return {
    phase: 'lobby', settings: { startBula, maxRefe },
    players: [null, null, null], dealer: 2, round: 0,
    hands: [[],[],[]], talon: [], discard: [],
    scores: { bula: [startBula,startBula,startBula], refe: [0,0,0], supe: [[0,0,0],[0,0,0],[0,0,0]] },
    auction: null, contract: null, follows: [null,null,null], followMessages: [null,null,null],
    caller: null, invited: null, doubler: null, doubleStage: 0, multiplier: 1,
    turn: null, firstBidder: null, trick: [], lastTrick: null,
    tricks: [0,0,0], trickNumber: 0, active: [],
    summary: null, log: [], finished: false
  };
}
function log(g, message) { g.log.push(message); if (g.log.length > 90) g.log.shift(); }
function publicName(g, seat) { return g.players[seat]?.name || `Player ${seat+1}`; }
function assertTurn(g, seat, phase) {
  assert(g.phase === phase, `This action isn't available during ${g.phase}.`);
  assert(g.turn === seat, 'It is not your turn.');
}
function rotationFrom(start, eligible) {
  for (let n = 0; n < 3; n++) { const s = mod(start+n); if (eligible.includes(s)) return s; }
  return null;
}
function addRefe(g, seat) {
  if (g.scores.bula.some(n => n < 0)) return false;
  if (g.scores.refe[seat] >= g.settings.maxRefe) return false;
  g.scores.refe[seat]++;
  return true;
}
export function deal(g, deckOverride = null) {
  assert(g.players.every(Boolean), 'Three players must join first.');
  assert(['lobby','summary'].includes(g.phase), 'Wait for the round to end.');
  assert(!g.finished, 'The match is finished.');
  const cards = deckOverride ? [...deckOverride] : shuffle(makeDeck());
  assert(cards.length === 32 && new Set(cards).size === 32 && cards.every(c => makeDeck().includes(c)), 'Invalid deck.');
  g.dealer = next(g.dealer);
  g.round++;
  g.hands = [[],[],[]];
  // 5 each, 2 into talon, then 5 each. Order starts right of dealer.
  let index = 0;
  for (let n = 0; n < 3; n++) {
    const seat = mod(g.dealer + 1 + n);
    g.hands[seat].push(...cards.slice(index, index + 5)); index += 5;
  }
  g.talon = cards.slice(index, index + 2); index += 2;
  for (let n = 0; n < 3; n++) {
    const seat = mod(g.dealer + 1 + n);
    g.hands[seat].push(...cards.slice(index, index + 5)); index += 5;
  }
  g.hands.forEach(sortHand);
  g.discard = [];
  g.contract = null;
  g.follows = [null,null,null]; g.followMessages = [null,null,null];
  g.caller = null; g.invited = null; g.doubler = null; g.doubleStage = 0; g.multiplier = 1;
  g.trick = []; g.lastTrick = null; g.tricks = [0,0,0]; g.trickNumber = 0;
  g.active = []; g.summary = null;
  g.firstBidder = next(g.dealer);
  g.turn = g.firstBidder;
  g.auction = { bid: 1, highSeat: null, hand: false, handValue: null,
    passed: [false,false,false], priority: g.firstBidder, history: [] };
  g.phase = 'auction';
  log(g, `Round ${g.round}: ${publicName(g,g.dealer)} dealt. Bidding begins with ${publicName(g,g.turn)}.`);
  return g;
}
function nextAuctionTurn(g, seat) {
  const eligible = [0,1,2].filter(i => !g.auction.passed[i]);
  if (!eligible.length) {
    for (let i = 0; i < 3; i++) addRefe(g,i);
    g.summary = { kind: 'pass', title: 'All players passed', details: 'Refe recorded where permitted. No tricks played.',
      scoreChanges: [0,0,0], supaChanges: [0,0,0] };
    g.phase = 'summary'; g.turn = null;
    log(g,'All players passed; redeal.');
    return;
  }
  if (eligible.length === 1 && g.auction.highSeat === eligible[0]) {
    endAuction(g); return;
  }
  // If just one bidder remains and has no bid, allow them to bid/pass.
  g.turn = rotationFrom(next(seat), eligible);
}
function endAuction(g) {
  const a = g.auction;
  assert(a.highSeat !== null, 'No winning bidder.');
  const won = a.highSeat;
  g.contract = { declarer: won, value: a.hand ? a.handValue : null, hand: a.hand,
    minimum: a.bid, trump: a.hand && a.handValue <= 5 ? CONTRACTS[a.handValue-2].suit : null };
  log(g, `${publicName(g,won)} won the bidding${a.hand ? ` with ${contractName(a.handValue,true)}` : ` at ${a.bid}`}.`);
  if (a.hand) { g.phase='following'; g.turn=null; beginFollowing(g); }
  else { g.phase='talon'; g.turn=won; }
}
export function auctionAction(g, seat, action, value = null) {
  assertTurn(g,seat,'auction');
  const a = g.auction;
  assert(!a.passed[seat], 'You have already passed.');
  const player = publicName(g,seat);
  switch (action) {
    case 'pass':
      a.passed[seat] = true;
      if (a.priority === seat) {
        const eligible = [0,1,2].filter(i => !a.passed[i]);
        a.priority = rotationFrom(next(seat),eligible);
      }
      log(g,`${player}: Dalje (pass).`); break;
    case 'bid':
      assert(!a.hand, 'Only a higher hand game can beat a hand declaration.');
      assert(isInt(value) && value >= 2 && value <= 7, 'Bid must be between 2 and 7.');
      assert(value > a.bid, 'Bid must be higher than the current bid.');
      assert(a.highSeat !== null || value === 2, 'The first ordinary bid must be Pik (2), unless you declare Igra.');
      a.bid = value; a.highSeat = seat;
      log(g,`${player}: ${value} (${contractName(value)}).`); break;
    case 'mogu':
      assert(!a.hand && a.highSeat !== null && a.highSeat !== seat, 'Mogu is unavailable.');
      assert(seat === a.priority, 'Only the player with priority can say Mogu.');
      a.highSeat = seat;
      log(g,`${player}: Mogu ${a.bid}.`); break;
    case 'hand':
      assert(isInt(value) && value >= 2 && value <= 7, 'Hand game must be Pik through Sans.');
      if (a.hand) assert(value > a.handValue, 'You must declare a higher hand game.');
      // A hand game wins against ordinary bidding and other lower hand games.
      a.hand = true; a.handValue = value; a.highSeat = seat; a.bid = value;
      log(g,`${player}: ${contractName(value,true)} (without talon).`); break;
    default: bad('Unknown bidding action.');
  }
  a.history.push({ seat, action, value });
  nextAuctionTurn(g,seat);
}
export function takeTalon(g,seat) {
  assertTurn(g,seat,'talon');
  assert(g.contract.declarer === seat, 'Only the declarer takes the talon.');
  g.hands[seat].push(...g.talon); sortHand(g.hands[seat]);
  g.phase='discard';
  log(g,`${publicName(g,seat)} revealed and picked up the talon.`);
}
export function discard(g,seat,cards) {
  assertTurn(g,seat,'discard');
  assert(Array.isArray(cards) && cards.length===2 && cards[0]!==cards[1], 'Select exactly two different cards.');
  assert(cards.every(c=>g.hands[seat].includes(c)), 'You cannot discard a card you do not hold.');
  g.hands[seat] = sortHand(g.hands[seat].filter(c=>!cards.includes(c)));
  g.discard = [...cards];
  g.phase = 'contract';
  log(g,`${publicName(g,seat)} set aside two cards face down.`);
}
export function declare(g,seat,value) {
  assertTurn(g,seat,'contract');
  assert(g.contract.declarer===seat, 'Only the declarer chooses the contract.');
  assert(isInt(value) && value>=g.contract.minimum && value<=7, 'Contract must be at least the winning bid.');
  g.contract.value=value;
  g.contract.trump = value<=5 ? CONTRACTS[value-2].suit : null;
  log(g,`${publicName(g,seat)} declared ${contractName(value)}.`);
  beginFollowing(g);
}
function beginFollowing(g) {
  const dec = g.contract.declarer;
  g.follows=[null,null,null]; g.followMessages=[null,null,null]; g.follows[dec] = true;
  if (g.contract.value===6) {
    otherSeats(dec).forEach(i=>g.follows[i]=true);
    g.phase='doubles'; g.turn=otherSeats(dec)[0]; g.doubleStage=0;
    log(g,'Betl: both defenders must play.');
  } else {
    g.phase='following'; g.turn=otherSeats(dec)[0];
  }
}
export function follow(g,seat,choice) {
  assertTurn(g,seat,'following');
  // Preserve compatibility with older clients while retaining the precise
  // spoken response for the three-button interface.
  const selected = typeof choice === 'boolean' ? (choice ? 'dodjem' : 'ne') : choice;
  const options = {dodjem: {follows:true, message:'Dođem'}, ne: {follows:false, message:'Ne'}, 'ne-bi': {follows:false, message:'Ne bi'}};
  assert(typeof selected === 'string' && Object.hasOwn(options, selected), 'Choose Dođem, Ne, or Ne bi.');
  assert(seat!==g.contract.declarer,'Declarer cannot be a defender.');
  g.follows[seat] = options[selected].follows;
  g.followMessages[seat] = options[selected].message;
  log(g,`${publicName(g,seat)}: ${options[selected].message}.`);
  const unresolved = otherSeats(g.contract.declarer).find(i=>g.follows[i]===null);
  if(unresolved!==undefined) { g.turn=unresolved; return; }
  const followers=otherSeats(g.contract.declarer).filter(i=>g.follows[i]);
  if (followers.length===1) { g.phase='calling'; g.turn=followers[0]; return; }
  // If both defenders stay out, declarer takes 10 tricks automatically, except
  // ordinary Pik, which still needs a kontra to be played.
  if(followers.length===0 && !(g.contract.value===2 && !g.contract.hand)) {
    g.tricks[g.contract.declarer]=10;
    finishRound(g,'Both defenders declined. Declarer receives all 10 tricks.');
    return;
  }
  g.phase='doubles'; g.doubleStage=0; g.turn=otherSeats(g.contract.declarer)[0];
}
export function callPartner(g,seat,willCall) {
  assertTurn(g,seat,'calling');
  assert(g.follows[seat]===true, 'Only the defender who is playing can invite the other defender.');
  assert(typeof willCall==='boolean','Choose whether to invite the other defender.');
  if(willCall) {
    g.caller=seat;
    const third=otherSeats(g.contract.declarer).find(i=>i!==seat);
    g.invited=third;
    g.follows[third]=true;
    g.followMessages[third]=null; // Invited back into play after declining.
    log(g,`${publicName(g,seat)}: Idemo zajedno (invite partner).`);
  } else log(g,`${publicName(g,seat)} chooses to play alone.`);
  g.phase='doubles'; g.doubleStage=0;
  g.turn=otherSeats(g.contract.declarer)[0];
}
function beginPlay(g) {
  if(g.contract.value===2 && !g.contract.hand && g.multiplier===1) {
    const written=addRefe(g,g.contract.declarer);
    if(written) {
      g.phase='summary'; g.turn=null;
      g.summary={ kind:'pass', title:'Pik without kontra', details:'No kontra was given. Declarer received one refe; cards are redealt.',scoreChanges:[0,0,0],supaChanges:[0,0,0] };
      log(g,'Ordinary Pik requires kontra: refe recorded, redeal.'); return;
    }
    g.tricks[g.contract.declarer]=10;
    finishRound(g,'Pik without kontra: no more refe can be recorded, so declarer passes automatically.'); return;
  }
  g.active=[g.contract.declarer,...otherSeats(g.contract.declarer).filter(i=>g.follows[i])];
  if(g.doubler!==null) g.active=[0,1,2];
  g.phase='playing'; g.trick=[]; g.trickNumber=0;
  // Sans always starts with the defender to the declarer's left (seat +2).
  g.turn=g.contract.value===7
    ? rotationFrom(mod(g.contract.declarer+2), g.active)
    : rotationFrom(g.firstBidder,g.active);
  log(g,`${contractName(g.contract.value,g.contract.hand)} begins. ${publicName(g,g.turn)} leads.`);
}
export function doubleAction(g,seat,action) {
  assertTurn(g,seat,'doubles');
  const dec=g.contract.declarer; const defenders=otherSeats(dec);
  if(g.doubleStage===0) {
    assert(defenders.includes(seat),'Only defenders may give kontra.');
    if(action==='kontra') {
      assert(seat!==g.invited, 'An invited partner can play tricks but cannot give Kontra or earn defensive points.');
      assert(g.follows[seat]===true, 'Only a participating defender may give kontra.');
      g.doubler=seat; g.multiplier=2; g.doubleStage=1; g.turn=dec;
      g.follows= [true,true,true];
      log(g,`${publicName(g,seat)}: KONTRA! (×2)`);
    } else if(action==='ok') {
      log(g,`${publicName(g,seat)}: Moze.`);
      if(seat===defenders[0]) g.turn=defenders[1];
      else beginPlay(g);
    } else bad('Choose Moze or Kontra.');
    return;
  }
  const expected=g.doubleStage%2===1 ? dec : g.doubler;
  assert(seat===expected,'Wrong player for a double.');
  if(action==='ok') { log(g,`${publicName(g,seat)} accepts the contract at ×${g.multiplier}.`); beginPlay(g); return; }
  const allowed=['','rekontra','subkontra'][g.doubleStage];
  assert(action===allowed,`Expected ${allowed} or Moze.`);
  g.multiplier*=2;
  log(g,`${publicName(g,seat)}: ${action.toUpperCase()}! (×${g.multiplier})`);
  if(g.doubleStage===2) { beginPlay(g); return; } // Subkontra is the final raise (×8).
  g.doubleStage++;
  g.turn=g.doubleStage%2===1 ? dec : g.doubler;
}
export function legalCards(g,seat) {
  if(g.phase!=='playing'||g.turn!==seat||!g.active.includes(seat)) return [];
  const hand=g.hands[seat];
  if(!g.trick.length) return [...hand];
  const led=suit(g.trick[0].card);
  const matching=hand.filter(c=>suit(c)===led);
  if(matching.length) return matching;
  if(g.contract.trump) {
    const trumps=hand.filter(c=>suit(c)===g.contract.trump);
    if(trumps.length) return trumps;
  }
  return [...hand];
}
export function winningSeat(trick,trump) {
  const led=suit(trick[0].card);
  let best=trick[0];
  const power=c=> (trump && suit(c)===trump ? 100 : suit(c)===led ? 50 : 0)+rank(c);
  for(const play of trick.slice(1)) if(power(play.card)>power(best.card)) best=play;
  return best.seat;
}
export function playCard(g,seat,card) {
  assertTurn(g,seat,'playing');
  assert(legalCards(g,seat).includes(card),'Illegal card. Follow suit, or trump if void.');
  g.hands[seat].splice(g.hands[seat].indexOf(card),1);
  sortHand(g.hands[seat]);
  g.trick.push({seat,card});
  if(g.trick.length===g.active.length) {
    const winner=winningSeat(g.trick,g.contract.trump);
    g.tricks[winner]++;
    g.trickNumber++;
    g.lastTrick={cards:[...g.trick],winner,number:g.trickNumber};
    g.turn=null;
    g.phase='trickReview';
    log(g,`Trick ${g.trickNumber}: ${publicName(g,winner)} wins.`);
  } else {
    g.turn=rotationFrom(next(seat),g.active);
  }
}
export function advanceTrick(g) {
  assert(g.phase==='trickReview','No completed trick to advance.');
  const winner=g.lastTrick.winner;
  g.trick=[];
  if(g.trickNumber===10) { finishRound(g); return; }
  g.turn=winner; g.phase='playing';
}
function finishRound(g,note='') {
  const dec=g.contract.declarer, defenders=otherSeats(dec);
  const val=g.contract.value+(g.contract.hand?1:0);
  const refeFactor=g.scores.refe[dec]>0 ? 2 : 1;
  const points=val*2*g.multiplier*refeFactor;
  const beforeBula=[...g.scores.bula];
  const beforeSupe=g.scores.supe.map(row=>[...row]);
  const won=g.tricks[dec];
  const decSuccess=g.contract.value===6 ? won===0 : won>=6;
  g.scores.bula[dec] += decSuccess ? -points : points;
  if(g.contract.value===6) {
    if(!decSuccess) {
      const supaBase=(g.contract.hand?70:60)*g.multiplier*refeFactor;
      if(g.doubler!==null) g.scores.supe[g.doubler][dec]+=supaBase;
      else defenders.forEach(i=>g.scores.supe[i][dec]+=supaBase);
    }
    if(g.doubler!==null && decSuccess) g.scores.bula[g.doubler]+=points;
  } else if(g.doubler!==null) {
    const defenseTricks=10-won;
    g.scores.supe[g.doubler][dec]+=defenseTricks*points;
    if(defenseTricks<5) g.scores.bula[g.doubler]+=points;
  } else if(g.caller!==null) {
    const defenseTricks=10-won;
    g.scores.supe[g.caller][dec]+=defenseTricks*points;
    if(defenseTricks<4) g.scores.bula[g.caller]+=points;
  } else {
    defenders.filter(i=>g.follows[i]).forEach(i=>{
      g.scores.supe[i][dec]+=g.tricks[i]*points;
      if(g.tricks[i]<2) g.scores.bula[i]+=points;
    });
  }
  if(g.scores.refe[dec]>0) g.scores.refe[dec]--;
  const changes=g.scores.bula.map((v,i)=>v-beforeBula[i]);
  const supeChanges=g.scores.supe.map((row,i)=>row.reduce((n,v,j)=>n+v-beforeSupe[i][j],0));
  g.summary={kind:'played',title:`${publicName(g,dec)} ${decSuccess?'passed':'fell'} on ${contractName(g.contract.value,g.contract.hand)}`,
    details:note||`${won} tricks for the declarer. ${g.multiplier>1?`Kontra multiplier ×${g.multiplier}. `:''}${refeFactor>1?'Refe doubled the stakes.':''}`,
    scoreChanges:changes, supaChanges:supeChanges,
    tricks:[...g.tricks], contract:{...g.contract}, multiplier:g.multiplier, refeFactor};
  g.phase='summary'; g.turn=null;
  log(g,`${g.summary.title}. Bula changes: ${changes.map((x,i)=>`${publicName(g,i)} ${x>=0?'+':''}${x}`).join(' · ')}.`);
  if(g.scores.bula.reduce((a,b)=>a+b,0)<=0) {
    g.finished=true;
    g.summary.details += ' Match complete: total bula is zero or below.';
    log(g,'Match finished. Compare final scores (lower is better).');
  }
}
export function finalScores(g) {
  return g.scores.bula.map((b,i)=>{
    const outgoing=g.scores.supe[i].reduce((a,v)=>a+v,0);
    const incoming=g.scores.supe.reduce((a,row)=>a+row[i],0);
    return b*10 - outgoing + incoming;
  });
}
export function allowedDoubles(g,seat) {
  if(g.phase!=='doubles' || g.turn!==seat || !isInt(seat))return [];
  if(g.doubleStage===0){
    return ['ok',...(seat!==g.invited && g.follows[seat]===true ? ['kontra']:[])];
  }
  return ['ok',g.doubleStage===1?'rekontra':'subkontra'];
}
export function viewFor(g,seat,roomCode) {
  const own=isInt(seat)&&seat>=0&&seat<=2;
  return {
    roomCode, seat, phase:g.phase, settings:g.settings, dealer:g.dealer,round:g.round,
    players:g.players.map((p,i)=>p?{name:p.name,online:!!p.online,seat:i}:null),
    scores:g.scores,finalScores:finalScores(g),
    hands:own?g.hands[seat]:[], handCounts:g.hands.map(h=>h.length),
    talonCount:g.talon.length, talon:g.phase==='talon' ? [...g.talon] : [],
    auction:g.auction ? {...g.auction} : null,
    contract:g.contract?{...g.contract}:null,
    follows:g.follows,followMessages:g.followMessages,caller:g.caller,invited:g.invited,doubler:g.doubler,doubleStage:g.doubleStage,multiplier:g.multiplier,
    turn:g.turn,firstBidder:g.firstBidder,trick:g.trick,lastTrick:g.lastTrick,availableDoubles:own?allowedDoubles(g,seat):[],
    tricks:g.tricks,trickNumber:g.trickNumber,active:g.active,
    legal:own ? legalCards(g,seat):[],summary:g.summary,finished:g.finished,
    log:g.log.slice(-22),names:CONTRACTS.map(c=>c.name)
  };
}
