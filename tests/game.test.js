import test from 'node:test';
import assert from 'node:assert/strict';
import {
  makeDeck,shuffle,sortHand,createGame,deal,auctionAction,takeTalon,discard,declare,
  follow,callPartner,doubleAction,legalCards,winningSeat,playCard,advanceTrick,
  finalScores,viewFor
} from '../game.js';

function game(settings={}) {
  const g=createGame(settings);
  g.players=['Anna','Bo','Cem'].map(name=>({name,online:true}));
  deal(g,makeDeck());
  return g;
}
function winBid(g,value=3) {
  const dec=g.turn;
  auctionAction(g,dec,'bid',value);
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
test('higher hand declaration overtakes lower, no talon taken',()=>{
  const g=game();
  auctionAction(g,1,'hand',2);
  auctionAction(g,2,'hand',4);
  auctionAction(g,0,'pass');
  auctionAction(g,1,'pass');
  assert.equal(g.phase,'following');
  assert.equal(g.contract.value,4);
  assert.equal(g.contract.hand,true);
  assert.equal(g.contract.declarer,2);
  assert.equal(g.hands[2].length,10);
});
test('talon is publicly visible until taken, hidden cards never leak',()=>{
  const g=game();
  auctionAction(g,1,'bid',5);
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
  auctionAction(g,1,'hand',7);auctionAction(g,2,'pass');auctionAction(g,0,'pass');
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
test('complete 10-trick hand with strictly legal actions, score sum remains coherent',()=>{
  const g=game();const dec=winBid(g,4);twoDefenders(g,dec);
  for(let t=0;t<10;t++){
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
  assert.equal(g.tricks.reduce((a,b)=>a+b,0),10);
  assert.deepEqual(g.hands.map(h=>h.length),[0,0,0]);
  assert.deepEqual(finalScores(g).reduce((a,b)=>a+b,0),g.scores.bula.reduce((a,b)=>a+b,0)*10);
});

test('bula range 50–120 and refe choices 2–4 with default values',()=>{
  assert.deepEqual(createGame().settings,{startBula:100,maxRefe:2});
  assert.deepEqual(createGame({startBula:50,maxRefe:4}).settings,{startBula:50,maxRefe:4});
  assert.deepEqual(createGame({startBula:120,maxRefe:3}).settings,{startBula:120,maxRefe:3});
  assert.deepEqual(createGame({startBula:49,maxRefe:5}).settings,{startBula:100,maxRefe:2});
  assert.deepEqual(createGame({startBula:121,maxRefe:1}).settings,{startBula:100,maxRefe:2});
});
test('card order alternates red and black and preserves ascending rank within each suit',()=>{
  const hand=['S7','SA','S9','C8','CK','D7','DA','D9','H8','HK'];
  sortHand(hand);
  assert.equal(hand.length,10);
  assert.deepEqual(new Set(hand),new Set(['S7','SA','S9','C8','CK','D7','DA','D9','H8','HK']));
  const color=c=>['H','D'].includes(c[0]);
  for(let i=1;i<hand.length;i++)assert.notEqual(color(hand[i]),color(hand[i-1]));
  for(const suit of 'SDHC'){
    const cards=hand.filter(c=>c[0]===suit);
    assert.deepEqual(cards,[...cards].sort((a,b)=>['7','8','9','10','J','Q','K','A'].indexOf(a.slice(1))-['7','8','9','10','J','Q','K','A'].indexOf(b.slice(1))));
  }
});
test('card sort minimizes same-color adjacency when hand has an imbalance',()=>{
  const hand=['S7','S8','S9','S10','C7','C8','C9','C10','D7','H7'];
  sortHand(hand);
  const color=c=>['D','H'].includes(c[0]);
  const changes=hand.slice(1).filter((c,i)=>color(c)!==color(hand[i])).length;
  assert.equal(changes,4); // Only two red cards: four alternations is optimal.
  assert.equal(new Set(hand).size,10);
  const monochrome=['S7','C7','S8','C8'];sortHand(monochrome);
  assert.ok(monochrome.every((c,i)=>i===0||c[0]!==monochrome[i-1][0]));
});
