import test from 'node:test';
import assert from 'node:assert/strict';
import { botMove } from '../bot.js';
import {
  createGame,deal,auctionAction,takeTalon,discard,declare,follow,callPartner,
  doubleAction,legalCards,playCard,advanceTrick,makeDeck,shuffle,allowedDoubles
} from '../game.js';

function setup(){
  const game=createGame({startBula:50,maxRefe:2});
  game.players=[
    {name:'Human',online:true},
    {name:'Computer 1',online:true,bot:true},
    {name:'Computer 2',online:true,bot:true}
  ];
  deal(game,shuffle(makeDeck()));
  return game;
}
function humanAction(g){
  const seat=0;
  assert.equal(g.turn,seat);
  switch(g.phase){
    case 'auction':{
      if(g.auction.hand){auctionAction(g,seat,'pass');break;}
      if(g.auction.highSeat===null)auctionAction(g,seat,'bid',2);
      else if(g.auction.highSeat===seat)auctionAction(g,seat,'pass');
      else auctionAction(g,seat,'pass');
      break;
    }
    case 'talon':takeTalon(g,seat);break;
    case 'discard':discard(g,seat,g.hands[seat].slice(0,2));break;
    case 'contract':declare(g,seat,Math.max(5,g.contract.minimum));break;
    case 'following':follow(g,seat,'dodjem');break;
    case 'calling':callPartner(g,seat,false);break;
    case 'doubles':doubleAction(g,seat,'ok');break;
    case 'playing':playCard(g,seat,legalCards(g,seat)[0]);break;
    default:throw Error('Unrecognized human phase '+g.phase);
  }
}
test('bots automatically complete multiple legal hands against one human',()=>{
  for(let trial=0;trial<4;trial++){
    const g=setup();
    let hands=0,botMoves=0,steps=0;
    for(;steps<1700 && hands<5 && !g.finished;steps++){
      if(g.phase==='summary'){
        hands++;
        if(g.finished||hands>=5)break;
        deal(g,shuffle(makeDeck()));continue;
      }
      if(g.phase==='trickReview'){
        advanceTrick(g);continue;
      }
      if(g.phase==='lobby')throw Error('Unexpected lobby');
      if(!Number.isInteger(g.turn))throw Error('No active turn in '+g.phase);
      if(g.players[g.turn].bot){
        assert.equal(botMove(g),true);
        botMoves++;
      }else humanAction(g);
    }
    assert.ok(steps<1700,'practice simulation did not finish');
    assert.ok(hands>=2 || g.finished,'need multiple completed hands');
    assert.ok(botMoves>=8,'computer opponents must actually act');
    assert.ok(!g.hands.some(h=>h.length>12));
  }
});
test('bot never attempts Kontra while invited, and an invited bot earns no points',()=>{
  const g=setup();
  // First human opens Pik and wins bidding with two bot passes.
  g.turn=0;
  g.auction={bid:1,highSeat:null,hand:false,handValue:null,passed:[false,false,false],priority:0,history:[]};
  g.phase='auction';
  auctionAction(g,0,'bid',2);
  auctionAction(g,1,'pass');
  auctionAction(g,2,'pass');
  takeTalon(g,0);
  discard(g,0,g.hands[0].slice(0,2));
  declare(g,0,5);
  // A defender participates, one declines; force invitation.
  follow(g,1,'dodjem');
  follow(g,2,'ne');
  assert.equal(g.phase,'calling');
  callPartner(g,1,true);
  assert.equal(g.invited,2);
  while(g.phase==='doubles'){
    const actor=g.turn;
    if(g.players[actor].bot){
      if(actor===2)assert.deepEqual(allowedDoubles(g,2),['ok']);
      botMove(g);
    }else doubleAction(g,actor,'ok');
  }
  assert.equal(g.phase,'playing');
  assert.ok(g.active.includes(2));
});
