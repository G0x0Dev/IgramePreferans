import test from 'node:test';
import assert from 'node:assert/strict';
import {createGame,makeDeck,deal,auctionAction,takeTalon,discard,declare,follow,callPartner,doubleAction,playCard,advanceTrick,finalScores,legalCards} from '../game.js';
import {botMove,chooseCard} from '../bot.js';
import {botMove as legacyMove} from './fixtures/legacy-bot.js';
import {observe,worlds,encode,decode,seededRandom,discardPlans,handQuality,scoreOutcome} from '../bot-search.js';

function fixedDeck(seed){
  const cards=makeDeck(),rng=seededRandom(seed);
  for(let i=cards.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[cards[i],cards[j]]=[cards[j],cards[i]];}
  return cards;
}
function setup(seed=1){
  const g=createGame({startBula:100,maxRefe:2});
  g.players=['A','B','C'].map(name=>({name,online:true,bot:true}));
  deal(g,fixedDeck(seed));
  return g;
}
function playing(seed=1){
  const g=setup(seed),dec=g.turn;
  auctionAction(g,dec,'bid',2);
  auctionAction(g,g.turn,'pass');auctionAction(g,g.turn,'pass');
  takeTalon(g,dec);discard(g,dec,g.hands[dec].slice(0,2));declare(g,dec,5);
  follow(g,g.turn,true);follow(g,g.turn,true);
  while(g.phase==='doubles')doubleAction(g,g.turn,'ok');
  return g;
}
test('bot card sampling is reproducible and cannot inspect real hidden hands',()=>{
  const g=playing(21),seat=g.turn;
  const a=observe(g,seat);
  const copy=structuredClone(g);
  const others=[0,1,2].filter(i=>i!==seat);
  // This changes the actual opponents' cards without changing anything the
  // acting bot can observe. Even an impossible hidden deal cannot change it.
  [copy.hands[others[0]],copy.hands[others[1]]]=[copy.hands[others[1]],copy.hands[others[0]]];
  assert.deepEqual(observe(copy,seat),a);
  assert.equal(chooseCard(copy,seat),chooseCard(g,seat));
  const samples=worlds(a,12,'test');
  assert.equal(samples.length,12);
  for(const w of samples){
    assert.deepEqual(w.hands[seat],a.own);
    assert.equal(new Set([...w.hands.flat(),...w.kitty]).size,32);
    assert.equal(w.kitty.length,2);
  }
});
test('sampled hidden cards respect publicly demonstrated suit and trump voids',()=>{
  const g=playing(37);
  // Play real legal cards until at least one off-suit response appears.
  let observation=null;
  for(let step=0;step<30&&g.phase!=='summary';step++){
    if(g.phase==='trickReview'){advanceTrick(g);continue;}
    const options=legalCards(g,g.turn);
    playCard(g,g.turn,options[0]);
    if(g.phase!=='playing')continue;
    const o=observe(g,g.turn);
    const all=[...o.completed,o.trick];
    if(all.some(t=>t.slice(1).some(p=>p.card>>3!==t[0].card>>3))){observation=o;break;}
  }
  assert.ok(observation,'fixed deal should produce a void');
  const o=observation,ss=worlds(o,16,'voids');
  assert.equal(ss.length,16);
  const played=[...o.completed,o.trick];
  for(const w of ss){
    assert.equal(w.hands.flat().length,o.counts.reduce((a,b)=>a+b,0));
    assert.equal(new Set([...w.hands.flat(),...w.kitty,...played.flat().map(p=>p.card)]).size,32);
    for(const trick of played)for(const p of trick.slice(1)){
      const led=trick[0].card>>3,actual=p.card>>3;
      if(led!==actual){
        assert.ok(w.hands[p.seat].every(c=>c>>3!==led));
        if(actual!==3)assert.ok(w.hands[p.seat].every(c=>c>>3!==3));
      }
    }
  }
});
test('discard planner preserves long trumps and evaluates Betl separately',()=>{
  const h=['CA','CK','CQ','CJ','C10','C9','SA','SK','D7','D8','H7','H8'].map(encode);
  const normal=discardPlans(h,5,1)[0];
  assert.equal(normal.hand.filter(c=>c>>3===3).length,6);
  const betl=discardPlans(h,6,1)[0];
  assert.ok(handQuality(betl.hand,6)>=handQuality(normal.hand,6));
  assert.equal(betl.discard.length,2);
});
test('sample score model matches actual engine score changes after normal or Betl play',()=>{
  for(const value of [4,5,6,7]){
    const g=setup(value),dec=g.turn;
    auctionAction(g,dec,'bid',2);auctionAction(g,g.turn,'pass');auctionAction(g,g.turn,'pass');
    takeTalon(g,dec);discard(g,dec,g.hands[dec].slice(0,2));declare(g,dec,value);
    while(g.phase==='following')follow(g,g.turn,true);
    while(g.phase==='doubles')doubleAction(g,g.turn,'ok');
    const before=finalScores(g);
    const config={value,hand:false,dec,active:[...g.active],multiplier:1,refeFactor:1};
    let steps=0;
    while(g.phase!=='summary'&&steps++<40){
      if(g.phase==='trickReview')advanceTrick(g);
      else playCard(g,g.turn,legalCards(g,g.turn)[0]);
    }
    assert.equal(g.phase,'summary');
    assert.deepEqual(scoreOutcome(config,g.tricks).scores,finalScores(g).map((n,i)=>n-before[i]));
  }
});
function playRound(seed,advancedSeat){
  const g=setup(seed),start=finalScores(g);
  let steps=0,moves=0,maxMs=0;
  while(g.phase!=='summary'&&steps++<100){
    if(g.phase==='trickReview'){advanceTrick(g);continue;}
    const t=performance.now();
    const advanced=g.turn===advancedSeat;
    assert.equal(advanced?botMove(g):legacyMove(g),true);
    if(advanced){moves++;maxMs=Math.max(maxMs,performance.now()-t);}
  }
  assert.equal(g.phase,'summary','all engines must finish a legal hand');
  const delta=finalScores(g).map((v,i)=>v-start[i]);
  return {delta,moves,maxMs};
}
test('competitive bot benchmark: paired seeded hands against the former bot',()=>{
  let oldTotal=0,newTotal=0,moves=0,maxMs=0,wins=0,losses=0;
  const rounds=90;
  for(let i=0;i<rounds;i++){
    const seat=i%3,seed='benchmark-'+i;
    const old=playRound(seed,-1);
    const improved=playRound(seed,seat);
    const relative=x=>x.delta.reduce((a,b)=>a+b,0)/3-x.delta[seat];
    const a=relative(old),b=relative(improved);
    oldTotal+=a;newTotal+=b;moves+=improved.moves;
    maxMs=Math.max(maxMs,improved.maxMs);
    if(b>a)wins++;else if(b<a)losses++;
  }
  console.log('COMPETITIVE_BENCHMARK '+JSON.stringify({rounds,oldAverage:oldTotal/rounds,newAverage:newTotal/rounds,improvement:(newTotal-oldTotal)/rounds,wins,losses,moves,maxMs:Math.round(maxMs)}));
  assert.ok(moves>30,'the new bot must actively bid and play');
  assert.ok(Number.isFinite(newTotal));
  assert.ok(newTotal>oldTotal,'competitive search should outperform the previous bot over the fixed benchmark');
  assert.ok(maxMs<5000,'each bot decision must have a practical upper latency');
});
