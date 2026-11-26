/** Competitive, fair solo opponents. The authoritative game engine still
 * validates every action. Search runs only on public observations and sampled
 * hidden cards, never the actual opponents' hands or unrevealed talon.
 */
import {auctionAction,igraDeclare,takeTalon,discard,declare,follow,callPartner,doubleAction,legalCards,playCard,allowedDoubles,availableAuctionBids} from './game.js';
import {observe,worlds,encode,decode,handQuality,discardPlans,simulate,evaluate,configFor} from './bot-search.js';

const seats=[0,1,2];
const VALUES=[2,3,4,5,6,7];
const cache=new WeakMap();
const SAMPLES=12;
const PLAY_SAMPLES=24;
const bidLimit=0.59;
const stableBest=items=>[...items].sort((a,b)=>b.mean-a.mean||b.success-a.success||b.value-a.value)[0];
function declarerConfig(o,value,hand=false){
  return configFor(o,value,{dec:o.seat,hand,active:seats,caller:null,doubler:null,multiplier:1});
}
function rateContract(o,samples,value,hand=false,withKitty=false){
  const config=declarerConfig(o,value,hand);
  let mean=0,success=0;
  for(const world of samples){
    const hands=world.hands.map(h=>[...h]);
    if(withKitty){
      hands[o.seat]=discardPlans([...o.own,...world.kitty],value,1)[0].hand;
    }
    const r=simulate({hands},config);
    mean+=r.utility[o.seat];success+=Number(r.success);
  }
  const n=samples.length||1;
  return {value,mean:samples.length?mean/n:-Infinity,success:success/n};
}
function auctionRatings(g,o){
  let round=cache.get(g);
  if(!round||round.round!==o.round){round={round:o.round,seats:new Map()};cache.set(g,round);}
  if(round.seats.has(o.seat))return round.seats.get(o.seat);
  const samples=worlds(o,SAMPLES,'auction');
  const result={
    ordinary:VALUES.map(value=>rateContract(o,samples,value,false,true)),
    hand:VALUES.map(value=>rateContract(o,samples,value,true,false))
  };
  round.seats.set(o.seat,result);
  return result;
}
function worthBid(r){
  // Betl is a much more expensive failure; require stronger evidence.
  return r.mean>2&&r.success>=(r.value===6?.80:r.value===7?.72:bidLimit);
}
function handBid(r){
  return r.mean>12&&r.success>=(r.value===6?.90:r.value===7?.85:.80);
}
function pickAuction(g,o){
  const a=o.auction,options=availableAuctionBids(g,o.seat);
  const ratings=auctionRatings(g,o);
  const ordinary=ratings.ordinary.filter(worthBid);
  const ceiling=Math.max(1,...ordinary.map(x=>x.value));
  const ordinaryBest=stableBest(ordinary);
  const eligibleHand=ratings.hand.filter(r=>handBid(r)&&(
    r.value===7?options.sans:r.value===6?options.betl:
    options.igra&&(a.handMode!=='suit'||r.value>=3)));
  const bestHand=stableBest(eligibleHand);
  // Skip the talon only when the expected reward supports the extra risk.
  if(bestHand&&(!ordinaryBest||bestHand.mean>=ordinaryBest.mean*.87||a.hand)){
    if(bestHand.value>=6)return ['hand',bestHand.value];
    return ['igra',null];
  }
  if(a.hand)return ['pass',null];
  if(a.highSeat!==null&&a.highSeat!==o.seat&&a.priority===o.seat&&a.bid<=ceiling)
    return ['mogu',null];
  if(options.ordinary!==null&&options.ordinary<=ceiling)return ['bid',options.ordinary];
  // An ordinary Pik without Kontra can earn a refe. Do not discard a good
  // hand just because the six-trick estimator is marginal.
  if(options.ordinary===2&&ratings.ordinary.some(r=>r.value<=5&&r.success>=.5&&r.mean>=-6))
    return ['bid',2];
  return ['pass',null];
}
function pickIgra(g,o){
  const ratings=auctionRatings(g,o).hand.filter(r=>r.value<=5&&
    (o.auction.igraPlayers[0]===o.seat||r.value>=3));
  const earlier=o.auction.igraDeclarations.filter(d=>Number.isInteger(d.value));
  const top=Math.max(0,...earlier.map(d=>d.value));
  const first=o.auction.igraPlayers[0]===o.seat;
  // A tie belongs to the earlier claimant, so later claimants only compete
  // if they have a stronger playable suit. Otherwise concede without revealing.
  const candidates=ratings.filter(r=>first||r.value>top);
  const best=stableBest(candidates);
  if(!first&&top&&(!best||best.success<.62||best.mean<=0))return 'weaker';
  return (best||stableBest(ratings)).value;
}
function plansFor(o){
  const samples=worlds(o,16,'talon-contract');
  const candidates=[];
  for(const value of VALUES.filter(v=>v>=o.contract.minimum)){
    const plans=discardPlans(o.own,value,o.own.length===12?3:1);
    for(const plan of plans){
      const config=declarerConfig(o,value);
      const modified=samples.map(w=>({hands:w.hands.map((h,i)=>i===o.seat?plan.hand:h)}));
      const rating=evaluate(modified,config,o.seat);
      // Avoid gambling on misere unless the actual low-card structure supports it.
      const penalty=value===6&&rating.success<.85?35:0;
      candidates.push({...plan,...rating,value,mean:rating.mean-penalty});
    }
  }
  const best=stableBest(candidates);
  return best||{value:o.contract.minimum,discard:discardPlans(o.own,o.contract.minimum,1)[0].discard};
}
function compareDefense(o){
  const samples=worlds(o,20,'defend');
  const dec=o.contract.declarer,other=seats.find(i=>i!==dec&&i!==o.seat);
  const alone=configFor(o,o.contract.value,{active:[dec,o.seat],caller:null,doubler:null});
  const both=configFor(o,o.contract.value,{active:seats,caller:null,doubler:null});
  const aloneRating=evaluate(samples,alone,o.seat),bothRating=evaluate(samples,both,o.seat);
  // A defender who sits out still benefits when the declarer falls. Compare
  // joining against actual solo defense, not simply a raw honor threshold.
  const otherAlone=evaluate(samples,configFor(o,o.contract.value,{active:[dec,other],caller:null,doubler:null}),o.seat);
  const expectedDecline=o.follows[other]===true?otherAlone.mean:
    o.follows[other]===false?-((o.contract.value+(o.contract.hand?1:0))*20/3):
    (otherAlone.mean-((o.contract.value+(o.contract.hand?1:0))*20/3))/2;
  const expectedJoin=o.follows[other]===true?bothRating.mean:o.follows[other]===false?aloneRating.mean:
    (aloneRating.mean+bothRating.mean)/2;
  return expectedJoin>expectedDecline+2;
}
function chooseInvite(o){
  const samples=worlds(o,20,'invite'),dec=o.contract.declarer;
  const solo=evaluate(samples,configFor(o,o.contract.value,{active:[dec,o.seat],caller:null,doubler:null}),o.seat);
  const invite=evaluate(samples,configFor(o,o.contract.value,{active:seats,caller:o.seat,doubler:null}),o.seat);
  return invite.mean>solo.mean+3;
}
function pickDouble(o,allowed){
  const raise=allowed.find(a=>a!=='ok');
  if(!raise)return 'ok';
  const samples=worlds(o,24,'double');
  const dec=o.contract.declarer;
  const active=[dec,...seats.filter(i=>i!==dec&&o.follows[i])];
  const normal=configFor(o,o.contract.value,{active,caller:o.caller,doubler:o.doubler});
  const doubled=configFor(o,o.contract.value,{active:seats,caller:o.caller,
    doubler:raise==='kontra'?o.seat:o.doubler,multiplier:o.multiplier*2});
  const current=evaluate(samples,normal,o.seat);
  const higher=evaluate(samples,doubled,o.seat);
  const winChance=o.seat===dec?higher.success:1-higher.success;
  // For Pik, no Kontra means no tricks and a refe (or automatic pass).
  const pikWithout=o.contract.value===2&&!o.contract.hand&&o.multiplier===1;
  const baseline=pikWithout?0:current.mean;
  return higher.mean>baseline+Math.max(5,Math.abs(baseline)*.06)&&winChance>=.66?raise:'ok';
}
export function chooseCard(g,seat){
  const legal=legalCards(g,seat);
  if(!legal.length)throw Error('Bot has no legal cards.');
  if(legal.length===1)return legal[0];
  const o=observe(g,seat),samples=worlds(o,PLAY_SAMPLES,'play'),config=configFor(o);
  if(!samples.length){
    // A malformed historical observation must not break a live game.
    const sorted=[...legal].sort((a,b)=>encode(a)%8-encode(b)%8);
    return sorted[0];
  }
  let best=legal[0],bestMean=-Infinity;
  for(const card of legal){
    const candidate=evaluate(samples,config,seat,{trick:o.trick,tricks:o.tricks,turn:seat,firstCard:encode(card)});
    if(candidate.mean>bestMean+1e-9||(Math.abs(candidate.mean-bestMean)<1e-9&&encode(card)%8<encode(best)%8)){
      best=card;bestMean=candidate.mean;
    }
  }
  return best;
}
export function botMove(g){
  const seat=g.turn;
  if(!Number.isInteger(seat)||!g.players[seat]?.bot)return false;
  const o=observe(g,seat);
  switch(g.phase){
    case 'auction':{
      const [action,value]=pickAuction(g,o);auctionAction(g,seat,action,value);break;
    }
    case 'igraReveal':igraDeclare(g,seat,pickIgra(g,o));break;
    case 'talon':takeTalon(g,seat);break;
    case 'discard':discard(g,seat,plansFor(o).discard.map(decode));break;
    case 'contract':declare(g,seat,plansFor(o).value);break;
    case 'following':follow(g,seat,compareDefense(o)?'dodjem':'ne');break;
    case 'calling':callPartner(g,seat,chooseInvite(o));break;
    case 'doubles':doubleAction(g,seat,pickDouble(o,allowedDoubles(g,seat)));break;
    case 'playing':playCard(g,seat,chooseCard(g,seat));break;
    default:return false;
  }
  return true;
}
