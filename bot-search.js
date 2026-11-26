/** Fair, bounded Monte Carlo engine for Preferans.
 * All opponent hands below are synthetic samples, not the server's real hands.
 * Numeric cards 0..31 keep repeated simulated tricks cheap.
 */
import {SUITS,RANKS} from './game.js';
export const encode=c=>SUITS.indexOf(c[0])*8+RANKS.indexOf(c.slice(1));
export const decode=c=>SUITS[c>>3]+RANKS[c&7];
const suit=c=>c>>3,rank=c=>c&7;
const deck=Array.from({length:32},(_,i)=>i);
const mod=n=>(n+3)%3;
const sum=a=>a.reduce((x,y)=>x+y,0);
const seats=[0,1,2];
export function seededRandom(key){
  let seed=2166136261;
  for(const c of String(key)){seed^=c.charCodeAt(0);seed=Math.imul(seed,16777619);}
  return ()=>{seed=(seed+0x6d2b79f5)|0;let t=Math.imul(seed^(seed>>>15),1|seed);t^=t+Math.imul(t^(t>>>7),61|t);return ((t^(t>>>14))>>>0)/4294967296;};
}
function shuffled(a,rng){
  a=[...a];for(let i=a.length-1;i>0;i--){const j=Math.floor(rng()*(i+1));[a[i],a[j]]=[a[j],a[i]];}return a;
}
export function nextActive(seat,active){
  for(let d=1;d<=3;d++)if(active.includes(mod(seat+d)))return mod(seat+d);
  return seat;
}
export function initialLead(value,dec,first,active){
  const start=value===7?mod(dec+2):first;
  return active.includes(start)?start:nextActive(start,active);
}
function winner(trick,trump){
  const led=suit(trick[0].card);let best=trick[0],power=-1;
  for(const p of trick){
    const s=suit(p.card),n=(s===trump?16:s===led?8:0)+rank(p.card);
    if(n>power){best=p;power=n;}
  }
  return best.seat;
}
export function legal(hand,trick,trump){
  if(!trick.length)return hand;
  const led=suit(trick[0].card),follow=hand.filter(c=>suit(c)===led);
  if(follow.length)return follow;
  if(trump>=0){const trumps=hand.filter(c=>suit(c)===trump);if(trumps.length)return trumps;}
  return hand;
}
const powerFor=(card,led,trump)=>(suit(card)===trump?16:suit(card)===led?8:0)+rank(card);

// Construct a strictly public-information snapshot. The only real hand we
// inspect is the bot's own. Lengths, completed tricks and the revealed
// ordinary talon are public; only the declarer knows its private discard.
export function observe(g,seat){
  const own=g.hands[seat].map(encode);
  const completed=(g.completedTricks||[]).map(t=>t.cards.map(p=>({seat:p.seat,card:encode(p.card)})));
  const trick=g.phase==='playing'?g.trick.map(p=>({seat:p.seat,card:encode(p.card)})):[];
  const publicTalon=g.contract&&!g.contract.hand&&g.phase!=='auction'&&g.phase!=='igraReveal'?g.talon.map(encode):[];
  const ownDiscard=g.contract?.declarer===seat&&!g.contract.hand?g.discard.map(encode):[];
  return {seat,own,counts:g.hands.map(h=>h.length),completed,trick,publicTalon,ownDiscard,
    contract:g.contract?{...g.contract}:null,auction:g.auction?structuredClone(g.auction):null,
    first:g.firstBidder,round:g.round,phase:g.phase,turn:g.turn,
    active:[...g.active],tricks:[...g.tricks],follows:[...g.follows],
    caller:g.caller,invited:g.invited,doubler:g.doubler,multiplier:g.multiplier,
    refe:[...g.scores.refe],bula:[...g.scores.bula],
    pikNoKontra:g.settings.pikNoKontra,maxRefe:g.settings.maxRefe};
}
export function observationSeed(o,tag=''){
  return [o.seat,o.round,o.phase,o.own.slice().sort((a,b)=>a-b),o.counts,o.contract?.value,
    o.completed.flat().map(p=>p.seat+':'+p.card),o.trick.map(p=>p.seat+':'+p.card),
    o.publicTalon,o.ownDiscard,o.auction?.history.map(h=>[h.seat,h.action,h.value]),tag].join('|');
}
// Sample deals consistent with publicly demonstrated void suits and trumps.
// The fourth bucket represents two unknown talon/discard cards. Known
// revealed talon cards can only be in the declarer's hand or in the discard.
export function sampleWorld(o,rng){
  const played=[...o.completed.flat(),...o.trick];
  const known=new Set([...o.own,...played.map(p=>p.card),...o.ownDiscard]);
  if(known.size!==o.own.length+played.length+o.ownDiscard.length)return null;
  const unknown=deck.filter(c=>!known.has(c));
  const cap=[...o.counts,0];cap[o.seat]=0;
  cap[3]=unknown.length-sum(cap);
  if(cap[3]<0||cap[3]>2)return null;
  const trump=o.contract?.trump?SUITS.indexOf(o.contract.trump):-1;
  const voids=[0,0,0];
  for(const trick of [...o.completed,o.trick]){
    if(!trick.length)continue;
    const lead=suit(trick[0].card);
    for(const p of trick.slice(1)){
      if(suit(p.card)!==lead){
        voids[p.seat]|=1<<lead;
        if(trump>=0&&suit(p.card)!==trump)voids[p.seat]|=1<<trump;
      }
    }
  }
  const allowed=c=>seats.filter(s=>s!==o.seat&&cap[s]>0&&!(voids[s]&(1<<suit(c)))&&
    (!o.publicTalon.includes(c)||o.contract?.declarer===s))
    .concat(cap[3]>0?[3]:[]);
  const rows=shuffled(unknown,rng).map(c=>({c,slots:allowed(c)})).sort((a,b)=>a.slots.length-b.slots.length);
  const buckets=[[],[],[],[]];buckets[o.seat]=[...o.own];
  const dead=new Set();
  function assign(i){
    if(i===rows.length)return cap.every(n=>n===0);
    const key=i+':'+cap.join(',');
    if(dead.has(key))return false;
    const {c,slots}=rows[i];
    // Randomized capacity-weighted order; backtracking enforces all constraints.
    const order=slots.filter(s=>cap[s]>0).map(s=>({s,k:-Math.log(Math.max(1e-9,rng()))/cap[s]})).sort((a,b)=>a.k-b.k);
    for(const {s} of order){cap[s]--;buckets[s].push(c);
      if(assign(i+1))return true;
      buckets[s].pop();cap[s]++;
    }
    dead.add(key);return false;
  }
  if(!assign(0))return null;
  return {hands:buckets.slice(0,3),kitty:[...o.ownDiscard,...buckets[3]]};
}
export function worlds(o,count,tag=''){
  const rng=seededRandom(observationSeed(o,tag));
  const result=[];
  for(let i=0;i<count;i++){const w=sampleWorld(o,rng);if(w)result.push(w);}
  return result;
}

// Fast hand quality for ranking discards before evaluating them in sampled
// deals. It values length, promoted honors and voids rather than just HCP.
export function handQuality(hand,value){
  const trump=value>=2&&value<=5?value-2:-1;
  let score=0;
  for(let s=0;s<4;s++){
    const cards=hand.filter(c=>suit(c)===s).map(rank).sort((a,b)=>b-a);
    const n=cards.length;
    if(value===6){
      // A missing low card makes higher cards dangerous in a misere hand.
      for(const r of cards){
        const missingLower=r-cards.filter(x=>x<r).length;
        score-=missingLower*(.8+r*.13);
      }
      if(!n)score+=1.3;
      else if(cards.includes(0))score+=1.5;
      continue;
    }
    let controls=0;
    for(let i=0;i<n;i++){
      const gap=7-cards[i]-i;
      controls+=Math.max(.035,1-gap*.24)*Math.max(.45,1-i*.12);
    }
    if(s===trump)score+=controls*1.55+n*.65+Math.max(0,n-3)*.8;
    else {
      score+=controls*(trump<0?1.38:1.0)+Math.max(0,n-3)*.3;
      if(trump>=0&&!n&&hand.some(c=>suit(c)===trump))score+=.6;
    }
  }
  return score;
}
export function discardPlans(hand,value,limit=2){
  if(hand.length===10)return [{hand:[...hand],discard:[],quality:handQuality(hand,value)}];
  const result=[];
  for(let i=0;i<hand.length;i++)for(let j=i+1;j<hand.length;j++){
    const kept=hand.filter((_,k)=>k!==i&&k!==j);
    result.push({hand:kept,discard:[hand[i],hand[j]],quality:handQuality(kept,value)});
  }
  return result.sort((a,b)=>b.quality-a.quality||a.discard[0]-b.discard[0]||a.discard[1]-b.discard[1]).slice(0,limit);
}

// Predict the rest of this trick with a cheap tactical policy. The cards
// consulted here belong ONLY to a sampled hypothetical deal.
function forecast(hands,trick,actor,card,active,trump,dec,misere){
  const t=[...trick,{seat:actor,card}];
  let seat=actor;
  while(t.length<active.length){
    seat=nextActive(seat,active);
    const options=legal(hands[seat],t,trump);
    let pick=options[0],best=-Infinity;
    for(const c of options){
      const w=winner([...t,{seat,card:c}],trump);
      let value;
      if(misere){
        const desired=seat===dec?w!==dec:w===dec;
        value=(desired?20:0)+(seat===dec?rank(c)*.2:-rank(c)*.2);
      }else{
        const friendly=(seat===dec)===(w===dec);
        value=(friendly?20:0)-rank(c)*.35-(suit(c)===trump?.65:0)+(w===seat?.3:0);
      }
      if(value>best){best=value;pick=c;}
    }
    t.push({seat,card:pick});
  }
  return winner(t,trump);
}
function policy(hands,trick,seat,active,trump,dec,misere,counts){
  const options=legal(hands[seat],trick,trump);
  if(options.length===1)return options[0];
  let best=options[0],bestScore=-Infinity;
  const mine=hands[seat];
  for(const c of options){
    const w=forecast(hands,trick,seat,c,active,trump,dec,misere);
    const s=suit(c),r=rank(c),len=mine.filter(x=>suit(x)===s).length;
    let score;
    if(misere){
      const desirable=seat===dec?w!==dec:w===dec;
      score=(desirable?100:0);
      // Shed dangerous high ranks safely; preserve low escape cards.
      if(seat===dec)score+=r*1.5;
      else {
        score-=r*.8;
        if(!trick.length){
          const targets=hands[dec].filter(x=>suit(x)===s);
          if(targets.length&&targets.every(x=>rank(x)>r))score+=12;
        }
      }
    }else{
      const friendly=(seat===dec)===(w===dec);
      score=(friendly?28:0)+(w===seat?2.5:0);
      // Keep useful high cards and trumps unless they are taking a trick.
      const higher=active.filter(i=>i!==seat).reduce((n,i)=>n+hands[i].filter(x=>suit(x)===s&&rank(x)>r).length,0);
      const keep=(higher===0?3.4:0)+r*.42+(s===trump?2.2:0);
      score-=keep*(w===seat?.25:1);
      if(!trick.length){
        if(seat===dec&&s===trump&&friendly&&mine.filter(x=>suit(x)===trump).length>=3)score+=4;
        if(s!==trump&&len===1&&trump>=0&&mine.some(x=>suit(x)===trump))score+=2.2;
        if(seat!==dec&&s===trump&&w===dec)score-=5;
      }
      if(trick.length&&w!==seat&&friendly)score+=1.5;
      if(counts[dec]===5&&seat!==dec&&friendly)score+=4;
    }
    if(score>bestScore||(score===bestScore&&c<best)){bestScore=score;best=c;}
  }
  return best;
}

// Reproduce the round's score deltas (not persistent state). Utility is the
// improvement against the table average: lower official scores are better.
export function scoreOutcome(config,tricks){
  const {value,hand,dec,caller=null,doubler=null,active,multiplier=1,refeFactor=1}=config;
  const points=(value+(hand?1:0))*2*multiplier*refeFactor;
  const defenders=seats.filter(s=>s!==dec); // only actual completed tricks
  const defense=defenders.reduce((n,s)=>n+tricks[s],0),success=value===6?tricks[dec]===0:tricks[dec]>=6;
  const scores=[0,0,0];
  scores[dec]+=(success?-1:1)*10*points;
  function supa(s,n){scores[s]-=n;scores[dec]+=n;}
  if(value===6){
    if(!success){
      const n=(hand?70:60)*multiplier*refeFactor;
      if(doubler!==null)supa(doubler,2*n);else defenders.forEach(s=>supa(s,n));
    }else if(doubler!==null)scores[doubler]+=10*points;
  }else if(doubler!==null){
    supa(doubler,defense*points);if(defense<5)scores[doubler]+=10*points;
  }else if(caller!==null){
    supa(caller,defense*points);if(defense<4)scores[caller]+=10*points;
  }else{
    const participating=defenders.filter(s=>active.includes(s));
    const goal=participating.length===2?4:2;
    for(const s of participating){supa(s,tricks[s]*points);if(defense<goal)scores[s]+=10*points;}
  }
  const avg=sum(scores)/3;
  return {scores,utility:scores.map(n=>avg-n),success,tricks};
}
// For the last three tricks, solve the small sampled game tree exactly.
// Each actor maximizes their own relative score (max-n), including individual
// supa and doubled/called defense incentives. No omniscient real-deal search.
function endgame(hands,table,counts,seat,config,trump){
  const dec=config.dec,misere=config.value===6;
  if((misere&&counts[dec]>0)||(!misere&&sum(counts)-counts[dec]>=5)||sum(counts)>=10||!hands[seat].length)
    return scoreOutcome(config,counts);
  let best=null;
  for(const card of legal(hands[seat],table,trump)){
    const nextHands=hands.map((h,i)=>i===seat?h.filter(c=>c!==card):h);
    const nextTable=[...table,{seat,card}];
    const done=nextTable.length===config.active.length;
    const nextSeat=done?winner(nextTable,trump):nextActive(seat,config.active);
    const nextCounts=[...counts];if(done)nextCounts[nextSeat]++;
    const result=endgame(nextHands,done?[]:nextTable,nextCounts,nextSeat,config,trump);
    if(!best||result.utility[seat]>best.utility[seat])best=result;
  }
  return best;
}
export function simulate(world,config,{trick=[],tricks=[0,0,0],turn=config.lead,firstCard=null}={}){
  const hands=world.hands.map(h=>[...h]),active=config.active,
    trump=config.value>=2&&config.value<=5?config.value-2:-1,dec=config.dec,misere=config.value===6;
  let table=trick.map(p=>({...p})),counts=[...tricks],seat=turn;
  let forced=firstCard;
  for(let moves=0;moves<32;){
    if((misere&&counts[dec]>0)||(!misere&&sum(counts)-counts[dec]>=5)||sum(counts)>=10)break;
    if(!hands[seat]?.length)break;
    if(forced===null&&active.every(i=>hands[i].length<=3))return endgame(hands,table,counts,seat,config,trump);
    const c=forced!==null?forced:policy(hands,table,seat,active,trump,dec,misere,counts);
    forced=null;
    const index=hands[seat].indexOf(c);
    if(index<0||!legal(hands[seat],table,trump).includes(c))throw Error('Invalid simulated play');
    hands[seat].splice(index,1);table.push({seat,card:c});moves++;
    if(table.length===active.length){
      seat=winner(table,trump);counts[seat]++;table=[];
    }else seat=nextActive(seat,active);
  }
  return scoreOutcome(config,counts);
}
export function configFor(o,value=o.contract?.value,overrides={}){
  const dec=overrides.dec??o.contract?.declarer??o.seat;
  const active=overrides.active??(o.active.length?o.active:[0,1,2]);
  return {value,hand:!!o.contract?.hand,dec,active,lead:initialLead(value,dec,o.first,active),
    caller:o.caller,doubler:o.doubler,multiplier:o.multiplier,refeFactor:o.refe[dec]>0?2:1,...overrides};
}
export function evaluate(samples,config,seat,options={}){
  if(!samples.length)return {mean:-Infinity,success:0,tricks:0};
  let total=0,success=0,tricks=0;
  for(const w of samples){
    const r=simulate(w,config,options);
    total+=r.utility[seat];success+=Number(r.success);tricks+=r.tricks[seat];
  }
  return {mean:total/samples.length,success:success/samples.length,tricks:tricks/samples.length};
}
