import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDeck,shuffle,sortHand,createGame,deal,auctionAction,igraDeclare,takeTalon,discard,declare,
  follow,callPartner,doubleAction,legalCards,winningSeat,playCard,advanceTrick,
  finalScores,settleMatch,viewFor
} from '../game.js';

function game(settings={}) {
  const g=createGame(settings);
  g.players=['Anna','Bo','Cem'].map(name=>({name,online:true}));
  deal(g,makeDeck());
  return g;
}
function winBid(g,value=3) {
  const dec=g.turn;
  auctionAction(g,dec,'bid',2);
  auctionAction(g,g.turn,'pass');
  auctionAction(g,g.turn,'pass');
  assert.equal(g.phase,'talon');
  assert.equal(g.contract.declarer,dec);
  takeTalon(g,dec);
  assert.equal(g.hands[dec].length,12);
  discard(g,dec,g.hands[dec].slice(0,2));
  declare(g,dec,value);
  return dec;
}
function twoDefenders(g,dec) {
  follow(g,g.turn,true); follow(g,g.turn,true);
  assert.equal(g.phase,'doubles');
  doubleAction(g,g.turn,'ok'); doubleAction(g,g.turn,'ok');
  assert.equal(g.phase,'playing');
}
test('32 unique cards, secure random shuffle, 10+10+10+2 dealing',()=>{
  const deck=makeDeck();
  assert.equal(deck.length,32);
  assert.equal(new Set(deck).size,32);
  assert.equal(shuffle(deck).length,32);
  const g=game();
  assert.deepEqual(g.hands.map(h=>h.length),[10,10,10]);
  assert.equal(g.talon.length,2);
  assert.equal(new Set(g.hands.flat().concat(g.talon)).size,32);
  assert.equal(g.dealer,0);
  assert.equal(g.turn,1);
});
test('all pass: refe to each, redeal after result',()=>{
  const g=game();
  for(let i=0;i<3;i++) auctionAction(g,g.turn,'pass');
  assert.equal(g.phase,'summary');
  assert.deepEqual(g.scores.refe,[1,1,1]);
  deal(g,makeDeck());
  assert.equal(g.phase,'auction');
  assert.equal(g.dealer,1);
  assert.deepEqual(g.scores.refe,[1,1,1]);
});
test('ordinary bids must advance Pik → Karo → Herc → Tref → Betl → Sans without skips',()=>{
  const g=game();
  assert.equal(g.auction.highSeat,null);
  assert.throws(()=>auctionAction(g,1,'bid',3),/first ordinary bid must be Pik/i);
  auctionAction(g,1,'pass');
  assert.throws(()=>auctionAction(g,2,'bid',5),/first ordinary bid must be Pik/i);
  auctionAction(g,2,'bid',2); // Pik
  assert.equal(g.auction.bid,2);
  assert.throws(()=>auctionAction(g,0,'bid',5),/next ordinary bid must be Karo/i);
  assert.equal(g.auction.bid,2);
  auctionAction(g,0,'bid',3); // Karo
  assert.equal(g.auction.bid,3);
  assert.throws(()=>auctionAction(g,2,'bid',6),/next ordinary bid must be Herc/i);
  auctionAction(g,2,'bid',4); // Herc
  assert.equal(g.auction.bid,4);
});
test('sequential raising and Mogu priority retain their normal rules',()=>{
  const g=game();
  auctionAction(g,1,'bid',2);
  auctionAction(g,2,'bid',3);
  auctionAction(g,0,'bid',4);
  auctionAction(g,1,'bid',5);
  auctionAction(g,2,'bid',6);
  auctionAction(g,0,'bid',7);
  assert.equal(g.auction.bid,7);
  assert.throws(()=>auctionAction(g,1,'bid',7),/must be higher/i);
  assert.equal(g.auction.highSeat,0);
  // Igra can still skip the standard sequence, including direct Igra-Sans.
  const h=game();
  auctionAction(h,1,'hand',7);
  assert.equal(h.auction.bid,7);
  assert.equal(h.auction.hand,true);
});
test('opening buttons offer next bid, Igra, Igra Betl and Igra Sans',()=>{
  const g=game();
  assert.deepEqual(viewFor(g,1,'TABLE').auctionOptions,
    {ordinary:2,igra:true,betl:true,sans:true});
  auctionAction(g,1,'bid',2);
  assert.deepEqual(viewFor(g,2,'TABLE').auctionOptions,
    {ordinary:3,igra:true,betl:true,sans:true});
  auctionAction(g,2,'bid',3);
  assert.deepEqual(viewFor(g,0,'TABLE').auctionOptions,
    {ordinary:4,igra:true,betl:true,sans:true});
  auctionAction(g,0,'bid',4);
  assert.deepEqual(viewFor(g,1,'TABLE').auctionOptions,
    {ordinary:5,igra:false,betl:false,sans:false});
  assert.deepEqual(viewFor(g,2,'TABLE').auctionOptions,
    {ordinary:null,igra:false,betl:false,sans:false});
  assert.throws(()=>auctionAction(g,1,'igra'),/first bidding round/i);
  assert.throws(()=>auctionAction(g,1,'hand',7),/first bidding round/i);
  auctionAction(g,1,'bid',5);
  assert.equal(g.auction.bid,5);
});
test('multiple Igra announcements are resolved by direct suit declarations without raising',()=>{
  const g=game();
  auctionAction(g,1,'igra');
  assert.equal(g.auction.handMode,'suit');
  assert.equal(g.auction.handValue,null);
  assert.deepEqual(viewFor(g,2,'TABLE').auctionOptions,
    {ordinary:null,igra:true,betl:true,sans:true});
  auctionAction(g,2,'igra');
  auctionAction(g,0,'igra');
  assert.equal(g.phase,'igraReveal');
  assert.deepEqual(g.auction.igraPlayers,[1,2,0]);
  igraDeclare(g,1,2);
  assert.equal(g.phase,'igraReveal');
  assert.equal(g.turn,2);
  igraDeclare(g,2,5); // Jumps directly to Tref.
  assert.equal(g.phase,'igraReveal');
  igraDeclare(g,0,3); // Lower direct declaration is permitted.
  assert.equal(g.phase,'following');
  assert.equal(g.contract.declarer,2);
  assert.equal(g.contract.value,5);
  assert.equal(g.contract.hand,true);
  assert.equal(g.hands[2].length,10,'no talon on suit Igra');
});
test('equal suit Igra bids are won by the earliest Igra claimant',()=>{
  const g=game();
  auctionAction(g,1,'igra');
  auctionAction(g,2,'igra');
  auctionAction(g,0,'pass');
  assert.equal(g.phase,'igraReveal');
  igraDeclare(g,1,4);
  igraDeclare(g,2,4);
  assert.equal(g.contract.declarer,1);
  assert.equal(g.contract.value,4);
  assert.equal(g.phase,'following');
});
test('Igra Betl and Igra Sans are declared directly and beat ordinary Igra',()=>{
  const g=game();
  auctionAction(g,1,'igra');
  auctionAction(g,2,'hand',6);
  assert.deepEqual(viewFor(g,0,'TABLE').auctionOptions,
    {ordinary:null,igra:false,betl:false,sans:true});
  assert.throws(()=>auctionAction(g,0,'igra'),/Only Igra Sans/i);
  assert.throws(()=>auctionAction(g,0,'hand',5),/only Igra Betl or Igra Sans/i);
  auctionAction(g,0,'hand',7);
  assert.equal(g.phase,'following');
  assert.equal(g.contract.hand,true);
  assert.equal(g.contract.value,7);
  assert.equal(g.contract.declarer,0);
  const h=game();
  auctionAction(h,1,'hand',6);
  auctionAction(h,2,'pass');auctionAction(h,0,'pass');
  assert.equal(h.phase,'doubles');
  assert.equal(h.contract.value,6);
});
test('after ordinary Pik an Igra claimant reveals any suit without increasing',()=>{
  const g=game();
  auctionAction(g,1,'bid',2);
  auctionAction(g,2,'igra');
  auctionAction(g,0,'pass');
  assert.equal(g.phase,'igraReveal');
  assert.equal(g.turn,2);
  igraDeclare(g,2,5);
  assert.equal(g.contract.declarer,2);
  assert.equal(g.contract.value,5);
  assert.equal(g.phase,'following');
});
test('a new hand starts with its own Igra opening opportunity',()=>{
  const g=game();
  auctionAction(g,1,'bid',2);
  auctionAction(g,2,'pass');auctionAction(g,0,'pass');
  assert.equal(g.phase,'talon');
  takeTalon(g,1);discard(g,1,g.hands[1].slice(0,2));declare(g,1,5);
  follow(g,g.turn,'ne');follow(g,g.turn,'ne');
  assert.equal(g.phase,'summary');
  deal(g,makeDeck());
  assert.equal(g.phase,'auction');
  assert.deepEqual(viewFor(g,g.turn,'TABLE').auctionOptions,
    {ordinary:2,igra:true,betl:true,sans:true});
});
test('invited defender cannot Kontra, earns no bula or supe, while inviter receives combined tricks',()=>{
  const g=game();
  const dec=winBid(g,4);
  const caller=g.turn;
  follow(g,caller,'dodjem');
  const invited=g.turn;
  follow(g,invited,'ne');
  assert.equal(g.phase,'calling');
  callPartner(g,caller,true);
  assert.equal(g.invited,invited);
  assert.equal(g.phase,'doubles');
  assert.deepEqual(viewFor(g,caller,'ROOM').availableDoubles,['ok','kontra']);
  // The inviter goes first and accepts, then the invited player cannot escalate.
  assert.equal(g.turn,caller);
  doubleAction(g,caller,'ok');
  assert.equal(g.turn,invited);
  assert.deepEqual(viewFor(g,invited,'ROOM').availableDoubles,['ok']); // Kontra button must be hidden.
  assert.throws(()=>doubleAction(g,invited,'kontra'),/invited partner/i);
  assert.equal(g.multiplier,1);
  doubleAction(g,invited,'ok');
  assert.equal(g.phase,'playing');
  g.tricks=[0,0,0];g.tricks[dec]=6;g.tricks[caller]=1;g.tricks[invited]=3;
  g.trickNumber=10;
  g.lastTrick={winner:dec,cards:[],number:10};g.phase='trickReview';
  advanceTrick(g);
  assert.equal(g.scores.supe[caller][dec],32);
  assert.equal(g.scores.bula[caller],100);
  assert.deepEqual(g.scores.supe[invited],[0,0,0]);
  assert.equal(g.scores.bula[invited],100);
});
test('caller can Kontra and invited defender remains point-free',()=>{
  const g=game();const dec=winBid(g,5);
  const caller=g.turn;
  follow(g,caller,true);const invited=g.turn;follow(g,invited,false);
  callPartner(g,caller,true);
  doubleAction(g,caller,'kontra');
  assert.equal(g.doubler,caller);
  assert.equal(g.turn,dec);
  doubleAction(g,dec,'ok');
  g.tricks=[0,0,0];g.tricks[dec]=7;g.tricks[caller]=2;g.tricks[invited]=1;
  g.trickNumber=10;g.lastTrick={winner:dec,cards:[],number:10};g.phase='trickReview';
  advanceTrick(g);
  assert.equal(g.scores.supe[caller][dec],60);
  assert.equal(g.scores.bula[caller],120);
  assert.equal(g.scores.bula[invited],100);
  assert.deepEqual(g.scores.supe[invited],[0,0,0]);
});
test('priority bidder can match using Mogu',()=>{
  const g=game();
  auctionAction(g,1,'bid',2);
  auctionAction(g,2,'bid',3);
  auctionAction(g,0,'pass');
  assert.equal(g.turn,1);
  auctionAction(g,1,'mogu');
  assert.equal(g.auction.highSeat,1);
  auctionAction(g,2,'pass');
  assert.equal(g.phase,'talon');
  assert.equal(g.contract.declarer,1);
  assert.equal(g.contract.minimum,3);
});
test('higher Igra suit declaration overtakes lower without taking talon',()=>{
  const g=game();
  auctionAction(g,1,'igra');
  auctionAction(g,2,'igra');
  auctionAction(g,0,'pass');
  assert.equal(g.phase,'igraReveal');
  igraDeclare(g,1,2);
  igraDeclare(g,2,4);
  assert.equal(g.phase,'following');
  assert.equal(g.contract.value,4);
  assert.equal(g.contract.hand,true);
  assert.equal(g.contract.declarer,2);
  assert.equal(g.hands[2].length,10);
});
test('talon is publicly visible until taken, hidden cards never leak',()=>{
  const g=game();
  auctionAction(g,1,'bid',2);
  auctionAction(g,2,'pass');auctionAction(g,0,'pass');
  assert.equal(viewFor(g,0,'SAMPLE').talon.length,2);
  takeTalon(g,1);
  assert.equal(viewFor(g,0,'SAMPLE').talon.length,0);
  assert.equal(viewFor(g,0,'SAMPLE').hands.length,10);
  assert.equal(viewFor(g,1,'SAMPLE').hands.length,12);
  assert.equal(viewFor(g,2,'SAMPLE').hands.length,10);
  assert.equal(viewFor(g,0,'SAMPLE').discard,undefined);
  assert.throws(()=>discard(g,1,['SA','SA']),/two different/);
});
test('lead follows the first bidder and suit/trump enforcement works',()=>{
  const g=game();
  const dec=winBid(g,3);
  twoDefenders(g,dec);
  assert.equal(g.turn,g.firstBidder);
  g.hands[0]=['H7','S7','D9'];
  g.hands[1]=['HA','D7','S9'];
  g.hands[2]=['H9','D8','C7'];
  g.active=[0,1,2];g.turn=0;g.trick=[];
  playCard(g,0,'H7');
  assert.equal(g.turn,1);
  assert.deepEqual(legalCards(g,1),['HA']);
  assert.throws(()=>playCard(g,1,'D7'),/Illegal card/);
  playCard(g,1,'HA');
  assert.deepEqual(legalCards(g,2),['H9']);
  playCard(g,2,'H9');
  assert.equal(g.phase,'trickReview');
  assert.equal(g.lastTrick.winner,1);
  advanceTrick(g);
  assert.equal(g.phase,'playing');
  assert.equal(g.turn,1);
  g.trick=[{seat:1,card:'H7'}]; g.turn=0;
  g.hands[0]=['D9','S7'];
  assert.deepEqual(legalCards(g,0),['D9']);
});
test('trump beats a higher non-trump rank',()=>{
  assert.equal(winningSeat([
    {seat:0,card:'HA'}, {seat:1,card:'H7'}, {seat:2,card:'D7'}
  ],'D'),2);
  assert.equal(winningSeat([
    {seat:0,card:'SA'}, {seat:1,card:'SK'}, {seat:2,card:'D7'}
  ],null),0);
});
test('without defenders a non-Pik declarer scores ten tricks immediately',()=>{
  const g=game();
  winBid(g,5);
  follow(g,g.turn,false);
  follow(g,g.turn,false);
  assert.equal(g.phase,'summary');
  assert.equal(g.tricks[1],10);
  assert.equal(g.scores.bula[1],90);
});
test('call partner: combined four tricks required, caller receives all supe',()=>{
  const g=game(); const dec=winBid(g,4);
  const caller=g.turn;
  follow(g,caller,true); follow(g,g.turn,false);
  assert.equal(g.phase,'calling');
  callPartner(g,caller,true);
  doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
  assert.equal(g.active.length,3);
  g.tricks=[1,1,1];g.tricks[dec]=7;
  g.tricks[caller]=1;
  g.tricks[[0,1,2].find(i=>i!==dec&&i!==caller)]=2;
  g.trickNumber=10;g.phase='trickReview';g.lastTrick={winner:dec,cards:[],number:10};
  advanceTrick(g);
  assert.equal(g.scores.supe[caller][dec],24);
  assert.equal(g.scores.bula[caller],108);
});
test('kontra → rekontra → subkontra ends at ×8 (mort is removed)',()=>{
  const g=game(); const dec=winBid(g,5);
  follow(g,g.turn,true);follow(g,g.turn,true);
  const doubler=g.turn;
  doubleAction(g,doubler,'kontra');
  assert.equal(g.multiplier,2);
  doubleAction(g,dec,'rekontra');
  assert.equal(g.multiplier,4);
  doubleAction(g,doubler,'subkontra');
  assert.equal(g.multiplier,8);
  assert.equal(g.phase,'playing');
  assert.throws(()=>doubleAction(g,dec,'mortkontra'),/This action isn't available/);
  assert.equal(g.active.length,3);
});
test('three distinct follow messages are visible and decline options both sit out',()=>{
  const g=game(); const dec=winBid(g,5);
  const first=g.turn,second=[0,1,2].find(i=>i!==first && i!==dec);
  follow(g,first,'ne');
  assert.equal(g.follows[first],false);
  assert.equal(g.followMessages[first],'Ne');
  assert.equal(viewFor(g,second,'ROOM').followMessages[first],'Ne');
  follow(g,second,'ne-bi');
  assert.equal(g.follows[second],false);
  assert.equal(g.followMessages[second],'Ne bi');
  assert.equal(g.phase,'summary');
  assert.match(g.log.at(-2),/Ne bi/);
});
test('Dođem chooses play and invalid follow choices are rejected',()=>{
  const g=game(); winBid(g,5);
  const first=g.turn;
  assert.throws(()=>follow(g,first,'neee'),/Choose Dođem, Ne, or Ne bi/);
  follow(g,first,'dodjem');
  assert.equal(g.follows[first],true);
  assert.equal(g.followMessages[first],'Dođem');
  follow(g,g.turn,'ne-bi');
  assert.equal(g.phase,'calling');
  callPartner(g,first,true);
  assert.equal(g.followMessages[[0,1,2].find(i=>i!==first&&i!==g.contract.declarer)],null);
});
test('regular Pik without kontra produces refe, unless the refe limit is reached',()=>{
  const g=game();winBid(g,2);
  follow(g,g.turn,true);follow(g,g.turn,true);
  doubleAction(g,g.turn,'ok'); doubleAction(g,g.turn,'ok');
  assert.equal(g.phase,'summary');
  assert.equal(g.scores.refe[1],1);
  const h=game({maxRefe:2}); h.scores.refe[1]=2;winBid(h,2);
  follow(h,h.turn,true);follow(h,h.turn,true);
  doubleAction(h,h.turn,'ok');doubleAction(h,h.turn,'ok');
  assert.equal(h.phase,'summary');
  assert.equal(h.scores.bula[1],92);
  assert.equal(h.scores.refe[1],1);
});
test('Sans always opens through declarer (seat +2), and hand contracts add one point',()=>{
  const g=game();
  auctionAction(g,1,'hand',7); // Igra Sans resolves immediately: no opponent can outbid Sans.
  assert.equal(g.phase,'following');
  follow(g,g.turn,true);follow(g,g.turn,true);
  doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
  assert.equal(g.turn,0);
  g.tricks=[0,6,4];g.trickNumber=10;
  g.lastTrick={winner:1,cards:[],number:10};g.phase='trickReview';
  advanceTrick(g);
  assert.equal(g.scores.bula[1],84); // hand Sans: 8 * 2
});
test('betl forces both defenders in; failing betl awards 60 supe to each',()=>{
  const g=game();
  auctionAction(g,1,'hand',6);auctionAction(g,2,'pass');auctionAction(g,0,'pass');
  assert.equal(g.phase,'doubles');
  doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
  g.tricks=[4,1,5];g.trickNumber=10;
  g.lastTrick={winner:2,cards:[],number:10};g.phase='trickReview';
  advanceTrick(g);
  assert.equal(g.scores.supe[0][1],70);
  assert.equal(g.scores.supe[2][1],70);
  assert.equal(g.scores.bula[1],114);
});
test('legal trick-taking stops at fifth defensive trick or after all ten',()=>{
  const g=game();const dec=winBid(g,4);twoDefenders(g,dec);
  for(let t=0;t<10 && g.phase==='playing';t++){
    const activeCount=g.active.length;
    for(let i=0;i<activeCount;i++){
      const seat=g.turn,valid=legalCards(g,seat);
      assert.ok(valid.length>=1,`no legal moves at trick ${t} for seat ${seat}`);
      playCard(g,seat,valid[0]);
    }
    assert.equal(g.phase,'trickReview');
    advanceTrick(g);
  }
  assert.equal(g.phase,'summary');
  const total=g.tricks.reduce((a,b)=>a+b,0);
  const defense=total-g.tricks[dec];
  assert.ok(total<=10);
  assert.ok(total===10||defense===5, 'early stop requires five actual defensive tricks');
  assert.equal(total,g.trickNumber, 'only completed tricks are counted');
  if(total<10)assert.ok(g.hands.some(h=>h.length>0));
  else assert.deepEqual(g.hands.map(h=>h.length),[0,0,0]);
  assert.deepEqual(finalScores(g).reduce((a,b)=>a+b,0),g.scores.bula.reduce((a,b)=>a+b,0)*10);
});

test('bula range 50–120 and refe choices 2–4 with default values',()=>{
  assert.deepEqual(createGame().settings,{startBula:100,maxRefe:2,pikNoKontra:'declarer'});
  assert.deepEqual(createGame({startBula:50,maxRefe:4,pikNoKontra:'all'}).settings,{startBula:50,maxRefe:4,pikNoKontra:'all'});
  assert.deepEqual(createGame({startBula:120,maxRefe:3}).settings,{startBula:120,maxRefe:3,pikNoKontra:'declarer'});
  assert.deepEqual(createGame({startBula:49,maxRefe:5}).settings,{startBula:100,maxRefe:2,pikNoKontra:'declarer'});
  assert.deepEqual(createGame({startBula:121,maxRefe:1,pikNoKontra:'invalid'}).settings,{startBula:100,maxRefe:2,pikNoKontra:'declarer'});
});
test('cards are grouped by suit and ranked 7 to Ace',()=>{
  const hand=['H10','D8','SA','C7','D7','H7','S7','CA','DK','HQ'];
  sortHand(hand);
  assert.deepEqual(hand,['S7','SA','D7','D8','DK','C7','CA','H7','H10','HQ']);
  const groups=[...new Set(hand.map(card=>card[0]))];
  assert.deepEqual(groups,['S','D','C','H']);
  assert.ok(Math.abs(groups.indexOf('D')-groups.indexOf('H'))>1);
});
test('red suits stay separated by a black suit if clubs are missing',()=>{
  const hand=['D8','H10','S9','D7','HA','S7'];
  sortHand(hand);
  assert.deepEqual(hand,['D7','D8','S7','S9','H10','HA']);
});
test('red and black suit groups alternate whenever a suit is missing',()=>{
  const scenarios=[
    {cards:['S7','C8','H9','H7','CA','S10'],suits:['S','H','C']},
    {cards:['S7','C8','D9','D7','CA','S10'],suits:['S','D','C']},
    {cards:['H7','C8','D9','D7','CA','H10'],suits:['D','C','H']},
    {cards:['S7','H8','D9','D7','HA','S10'],suits:['D','S','H']},
    {cards:['S7','C8','H9','D7','CA','S10'],suits:['S','D','C','H']}
  ];
  for(const {cards,suits} of scenarios){
    const original=[...cards];
    sortHand(cards);
    const uniqueSuitOrder=cards.map(c=>c[0]).filter((v,i,a)=>i===0||v!==a[i-1]);
    assert.deepEqual(uniqueSuitOrder,suits);
    assert.deepEqual([...cards].sort(),[...original].sort(),'sorting must keep all cards');
    for(const suit of uniqueSuitOrder){
      const ranks=cards.filter(c=>c[0]===suit).map(c=>c.slice(1));
      assert.deepEqual(ranks,[...ranks].sort((a,b)=>['7','8','9','10','J','Q','K','A'].indexOf(a)-['7','8','9','10','J','Q','K','A'].indexOf(b)));
    }
  }
  const blackOnly=['C7','SA','S7','CA'];
  sortHand(blackOnly);
  assert.deepEqual(blackOnly,['S7','SA','C7','CA'],'black suits can touch when no red suit exists');
});
test('the public game view contains latest bid, Igra and Dalje choices per seat',()=>{
  const g=game();
  auctionAction(g,1,'bid',2);
  auctionAction(g,2,'igra');
  auctionAction(g,0,'pass');
  assert.equal(g.phase,'igraReveal');
  const publicView=viewFor(g,0,'TABLE');
  assert.deepEqual(publicView.auction.history.map(h=>({seat:h.seat,action:h.action,value:h.value})),[
    {seat:1,action:'bid',value:2},
    {seat:2,action:'igra',value:null},
    {seat:0,action:'pass',value:null}
  ]);
  assert.equal(publicView.auction.igraPlayers[0],2);
});
test('ranks stay ascending and no cards are lost even when a hand lacks black suits',()=>{
  const hand=['H10','D8','HA','D7','D9','H7'];
  sortHand(hand);
  assert.deepEqual(hand,['D7','D8','D9','H7','H10','HA']);
  assert.equal(new Set(hand).size,6);
});


test('ordinary game stops at five combined defensive tricks, scores only actual captured tricks',()=>{
  const g=game();const dec=winBid(g,5);twoDefenders(g,dec);
  const defenders=[0,1,2].filter(seat=>seat!==dec);
  g.tricks[dec]=3;g.tricks[defenders[0]]=2;g.tricks[defenders[1]]=2;
  g.trickNumber=7;g.lastTrick={winner:defenders[0],cards:[],number:7};g.phase='trickReview';
  advanceTrick(g);
  assert.equal(g.phase,'playing','four defensive tricks are not yet enough');
  g.tricks[defenders[1]]++;g.trickNumber=8;
  g.lastTrick={winner:defenders[1],cards:[],number:8};g.phase='trickReview';
  advanceTrick(g);
  assert.equal(g.phase,'summary');
  assert.equal(g.trickNumber,8);
  assert.equal(g.scores.bula[dec],110,'declarer records normal Tref failure');
  assert.equal(g.scores.supe[defenders[0]][dec],20,'two actual tricks earned 20 supe');
  assert.equal(g.scores.supe[defenders[1]][dec],30,'three actual tricks earned 30 supe');
  assert.deepEqual(g.summary.tricks,g.tricks);
  assert.match(g.summary.details,/five tricks/i);
  assert.throws(()=>advanceTrick(g),/No completed trick/);
});
test('Kontra scoring at early finish counts five defensive tricks, not ten minus declarer',()=>{
  const g=game(),dec=winBid(g,5);
  follow(g,g.turn,true);follow(g,g.turn,true);
  const doubler=g.turn;
  doubleAction(g,doubler,'kontra');
  doubleAction(g,dec,'ok');
  const defenders=[0,1,2].filter(seat=>seat!==dec);
  g.tricks[dec]=2;g.tricks[defenders[0]]=3;g.tricks[defenders[1]]=2;
  g.trickNumber=7;g.phase='trickReview';
  g.lastTrick={winner:defenders[0],number:7,cards:[]};
  advanceTrick(g);
  assert.equal(g.phase,'summary');
  assert.equal(g.scores.bula[dec],120);
  assert.equal(g.scores.supe[doubler][dec],100,'only five supe-bearing tricks at 20 each');
  assert.equal(g.scores.bula[doubler],100,'doubler met the five-trick goal');
});
test('invited partner earns nothing when their side reaches five tricks early',()=>{
  const g=game(),dec=winBid(g,5);
  const caller=g.turn;
  follow(g,caller,true);follow(g,g.turn,false);
  const invited=[0,1,2].find(seat=>seat!==dec&&seat!==caller);
  callPartner(g,caller,true);
  doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
  g.tricks[dec]=1;g.tricks[caller]=2;g.tricks[invited]=3;
  g.trickNumber=6;g.phase='trickReview';
  g.lastTrick={winner:invited,number:6,cards:[]};
  advanceTrick(g);
  assert.equal(g.phase,'summary');
  assert.equal(g.scores.supe[caller][dec],50,'inviter takes all five scored tricks');
  assert.deepEqual(g.scores.supe[invited],[0,0,0]);
  assert.equal(g.scores.bula[invited],100);
});
test('Betl remains exempt from five-defender-trick early stop',()=>{
  const g=game();
  auctionAction(g,1,'hand',6);auctionAction(g,2,'pass');auctionAction(g,0,'pass');
  doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
  const dec=g.contract.declarer,defenders=[0,1,2].filter(seat=>seat!==dec);
  g.tricks[defenders[0]]=3;g.tricks[defenders[1]]=2;
  g.trickNumber=5;g.phase='trickReview';
  g.lastTrick={winner:defenders[0],number:5,cards:[]};
  advanceTrick(g);
  assert.equal(g.phase,'playing','Betl continues even after five defensive tricks');
  // When the declarer remains trick-free, Betl continues through all ten.
  g.tricks[dec]=0;g.tricks[defenders[0]]=5;g.tricks[defenders[1]]=5;
  g.trickNumber=10;g.phase='trickReview';
  g.lastTrick={winner:defenders[0],number:10,cards:[]};
  advanceTrick(g);
  assert.equal(g.phase,'summary');
  assert.equal(g.scores.bula[dec],86,'successful Igra-Betl is 14 bula');
  assert.equal(g.scores.supe[defenders[0]][dec],0);
  assert.equal(g.scores.supe[defenders[1]][dec],0);
});

test('plain Betl and Igra-Betl fail immediately on declarer first captured trick',()=>{
  for(const handContract of [false,true]){
    const g=game();
    if(handContract){
      auctionAction(g,1,'hand',6);
      auctionAction(g,2,'pass');
      auctionAction(g,0,'pass');
    }else{
      winBid(g,6);
    }
    assert.equal(g.phase,'doubles');
    doubleAction(g,g.turn,'ok');
    doubleAction(g,g.turn,'ok');
    assert.equal(g.phase,'playing');
    assert.equal(g.contract.declarer,1);
    // Three legal heart cards: Ace makes the declarer take the first trick.
    // Everyone also keeps an unplayed club card.
    g.hands=[['H7','C8'],['HA','CA'],['H9','C9']];
    g.active=[0,1,2];g.turn=0;g.trick=[];g.tricks=[0,0,0];
    g.trickNumber=0;
    playCard(g,0,'H7');
    assert.equal(g.phase,'playing');
    playCard(g,1,'HA');
    assert.equal(g.phase,'playing');
    playCard(g,2,'H9');
    assert.equal(g.phase,'summary','Betl must stop as soon as declarer wins');
    assert.equal(g.tricks[1],1);
    assert.equal(g.trickNumber,1);
    assert.equal(g.lastTrick.winner,1);
    assert.deepEqual(g.hands.map(h=>h.length),[1,1,1]);
    assert.equal(g.scores.bula[1],handContract?114:112);
    assert.equal(g.scores.supe[0][1],handContract?70:60);
    assert.equal(g.scores.supe[2][1],handContract?70:60);
    assert.match(g.summary.details,/Betl failed.*ended immediately/i);
    assert.throws(()=>playCard(g,1,'CA'),/action isn't available during summary/i);
    assert.throws(()=>advanceTrick(g),/No completed trick/);
  }
});


test('only the first Igra claimant may declare Pik; later players may say my game is weaker',()=>{
  const g=game();
  auctionAction(g,1,'igra');
  auctionAction(g,2,'igra');
  auctionAction(g,0,'igra');
  assert.equal(g.phase,'igraReveal');
  igraDeclare(g,1,3);
  assert.throws(()=>igraDeclare(g,2,2),/Only the first Igra claimant may declare Igra Pik/i);
  assert.equal(g.turn,2,'invalid declaration must not advance the auction');
  igraDeclare(g,2,5);
  igraDeclare(g,0,'weaker');
  assert.equal(g.phase,'following');
  assert.equal(g.contract.declarer,2);
  assert.equal(g.contract.value,5);
  assert.deepEqual(g.auction.igraDeclarations.map(d=>d.value),[3,5,null]);
  assert.equal(g.auction.igraDeclarations[2].weaker,true);
});
test('a weaker Igra declaration is not accepted before a stronger suit is known',()=>{
  const g=game();
  auctionAction(g,1,'igra');
  auctionAction(g,2,'igra');
  auctionAction(g,0,'pass');
  assert.equal(g.phase,'igraReveal');
  assert.throws(()=>igraDeclare(g,1,'weaker'),/only after an earlier Igra claimant/i);
  igraDeclare(g,1,2);
  assert.throws(()=>igraDeclare(g,2,2),/Only the first Igra claimant/i);
  igraDeclare(g,2,'weaker');
  assert.equal(g.contract.declarer,1);
  assert.equal(g.contract.value,2);
});
test('Betl with Kontra awards the caller both defenders supa shares',()=>{
  for(const hand of [false,true]){
    const g=game(),dec=hand?1:winBid(g,6);
    if(hand){
      auctionAction(g,1,'hand',6);
      auctionAction(g,2,'pass');
      auctionAction(g,0,'pass');
    }
    assert.equal(g.phase,'doubles');
    const doubler=g.turn;
    doubleAction(g,doubler,'kontra');
    doubleAction(g,dec,'ok');
    g.tricks=[0,0,0];g.tricks[dec]=1;
    g.trickNumber=1;g.phase='trickReview';
    g.lastTrick={winner:dec,number:1,cards:[]};
    advanceTrick(g);
    assert.equal(g.phase,'summary');
    const expected=hand?280:240;
    assert.equal(g.scores.supe[doubler][dec],expected,
      'caller receives both 70/60 allocations multiplied by Kontra');
    const passive=[0,1,2].find(i=>i!==dec&&i!==doubler);
    assert.equal(g.scores.supe[passive][dec],0);
    assert.equal(g.scores.bula[dec],hand?128:124);
  }
});
test('both defenders pass together with four tricks; captured-trick split only affects supa',()=>{
  for(const [first,second] of [[3,1],[4,0],[2,2],[1,3],[0,4]]){
    const g=game(),dec=winBid(g,4);twoDefenders(g,dec);
    const [d1,d2]=[0,1,2].filter(i=>i!==dec);
    g.tricks=[0,0,0];
    g.tricks[dec]=6;g.tricks[d1]=first;g.tricks[d2]=second;
    g.trickNumber=10;g.phase='trickReview';
    g.lastTrick={winner:dec,cards:[],number:10};
    advanceTrick(g);
    assert.equal(g.phase,'summary');
    assert.equal(g.scores.bula[dec],92,'declarer with six tricks passes at Herc (-8 bula)');
    assert.equal(g.scores.bula[d1],100,'first defender passes on their combined four tricks');
    assert.equal(g.scores.bula[d2],100,'second defender passes regardless of individual share');
    assert.equal(g.scores.supe[d1][dec],first*8,'first defender receives only their captured-trick supa');
    assert.equal(g.scores.supe[d2][dec],second*8,'second defender receives only their captured-trick supa');
    assert.deepEqual(g.summary.scoreChanges,[0,-8,0],
      'only the declarer changes bula (declarer sits at seat 1)');
    assert.match(g.summary.details,/Both defenders passed together with 4 tricks/i);
  }
});
test('when both defenders play and take only three combined tricks, both fall regardless of split',()=>{
  for(const [first,second] of [[3,0],[2,1],[0,3]]){
    const g=game(),dec=winBid(g,4);twoDefenders(g,dec);
    const [d1,d2]=[0,1,2].filter(i=>i!==dec);
    g.tricks=[0,0,0];
    g.tricks[dec]=7;g.tricks[d1]=first;g.tricks[d2]=second;
    g.trickNumber=10;g.phase='trickReview';
    g.lastTrick={winner:dec,cards:[],number:10};
    advanceTrick(g);
    assert.equal(g.scores.bula[dec],92);
    assert.equal(g.scores.bula[d1],108,'both defenders miss their shared four-trick goal');
    assert.equal(g.scores.bula[d2],108);
    assert.equal(g.scores.supe[d1][dec],first*8);
    assert.equal(g.scores.supe[d2][dec],second*8);
    assert.match(g.summary.details,/Both defenders fell together with 3 tricks/i);
  }
});
test('early finish after defenders take five combined tricks never penalizes either individual',()=>{
  const g=game(),dec=winBid(g,5);twoDefenders(g,dec);
  const defenders=[0,1,2].filter(i=>i!==dec);
  g.tricks=[0,0,0];g.tricks[defenders[0]]=5;
  g.trickNumber=5;g.phase='trickReview';
  g.lastTrick={winner:defenders[0],number:5,cards:[]};
  advanceTrick(g);
  assert.equal(g.phase,'summary');
  assert.equal(g.scores.bula[dec],110);
  assert.equal(g.scores.bula[defenders[0]],100);
  assert.equal(g.scores.bula[defenders[1]],100,
    'defender with zero tricks passes because the team captured five');
  assert.equal(g.scores.supe[defenders[0]][dec],50);
  assert.equal(g.scores.supe[defenders[1]][dec],0);
  assert.match(g.summary.details,/Both defenders passed together with 5 tricks/i);
});
test('a lone participating defender retains the separate two-trick minimum',()=>{
  for(const [own,passes] of [[2,true],[1,false]]){
    const g=game(),dec=winBid(g,4);
    const lone=g.turn;
    follow(g,lone,true);follow(g,g.turn,false);
    assert.equal(g.phase,'calling');
    callPartner(g,lone,false);
    doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
    const absent=[0,1,2].find(i=>i!==dec&&i!==lone);
    g.tricks=[0,0,0];g.tricks[dec]=10-own;g.tricks[lone]=own;
    g.trickNumber=10;g.phase='trickReview';
    g.lastTrick={winner:dec,cards:[],number:10};
    advanceTrick(g);
    assert.equal(g.scores.bula[lone],passes?100:108);
    assert.equal(g.scores.bula[absent],100);
    assert.equal(g.scores.supe[lone][dec],own*8);
  }
});
test('Pik without Kontra defaults to declarer-refe but can award all eligible players a refe',()=>{
  const g=game({pikNoKontra:'all',maxRefe:2});
  winBid(g,2);follow(g,g.turn,'dodjem');follow(g,g.turn,'dodjem');
  doubleAction(g,g.turn,'ok');doubleAction(g,g.turn,'ok');
  assert.equal(g.phase,'summary');
  assert.deepEqual(g.scores.refe,[1,1,1]);
  assert.deepEqual(g.scores.bula,[100,100,100]);
  assert.match(g.summary.details,/received a refe/i);
  const h=game({pikNoKontra:'all',maxRefe:2});
  h.scores.refe=[2,2,1];
  winBid(h,2);follow(h,h.turn,'dodjem');follow(h,h.turn,'dodjem');
  doubleAction(h,h.turn,'ok');doubleAction(h,h.turn,'ok');
  assert.deepEqual(h.scores.refe,[2,2,2],
    'players already at their limit do not gain extra refe');
  const z=game({pikNoKontra:'all',maxRefe:2});
  z.scores.refe=[2,2,2];
  winBid(z,2);follow(z,z.turn,'dodjem');follow(z,z.turn,'dodjem');
  doubleAction(z,z.turn,'ok');doubleAction(z,z.turn,'ok');
  assert.equal(z.phase,'summary');
  assert.equal(z.scores.bula[1],92,'existing fallback is an automatic Pik pass');
});
test('otpisivanje reduces total bula to zero, favouring lowest existing bula',()=>{
  const g=game();
  g.phase='summary';g.scores.bula=[24,34,28];g.scores.refe=[1,0,2];
  g.scores.supe[0][1]=37;
  assert.deepEqual(settleMatch(g),[28,29,29]);
  assert.deepEqual(g.scores.bula,[-4,5,-1]);
  assert.equal(g.scores.bula.reduce((a,b)=>a+b),0);
  assert.deepEqual(g.scores.refe,[1,0,2]);
  assert.equal(g.scores.supe[0][1],37);
  assert.equal(g.finished,true);
  assert.equal(g.summary.kind,'settlement');
  assert.throws(()=>settleMatch(g),/unfinished match/i);
  const h=game();
  h.phase='summary';h.scores.bula=[8,2,0];
  assert.deepEqual(settleMatch(h),[4,3,3]);
  assert.deepEqual(h.scores.bula,[4,-1,-3]);
  const bad=game();
  assert.throws(()=>settleMatch(bad),/only possible between rounds/i);
});
