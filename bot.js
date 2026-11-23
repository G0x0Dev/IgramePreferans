/** Simple, deterministic computer opponents for solo practice.
 * Each bot chooses using its own hand and the public trick, never private opponents' cards.
 */
import { RANKS,SUITS,CONTRACTS,auctionAction,takeTalon,discard,declare,follow,callPartner,doubleAction,legalCards,winningSeat,playCard,allowedDoubles } from './game.js';

const rank=card=>RANKS.indexOf(card.slice(1));
const suit=card=>card[0];
const ranks=g=>g.map(rank);
const highCardPoints=hand=>hand.reduce((sum,c)=>sum+([0,0,0,0,1,2,3,4][rank(c)]||0),0);
const maxSuit=hand=>Math.max(...SUITS.map(s=>hand.filter(c=>suit(c)===s).length));
const strength=hand=>highCardPoints(hand)+Math.max(0,maxSuit(hand)-3)*2;
const weakest=hand=>[...hand].sort((a,b)=>rank(a)-rank(b)||SUITS.indexOf(suit(a))-SUITS.indexOf(suit(b)));
const strongest=hand=>[...hand].sort((a,b)=>rank(b)-rank(a));

function chooseCard(g,seat){
  const legal=legalCards(g,seat);
  if(!legal.length)throw Error('Bot has no legal cards.');
  const preferLosing=g.contract?.value===6 && g.contract.declarer===seat;
  if(!g.trick.length){
    if(preferLosing)return weakest(legal)[0];
    // High cards from the most plentiful suit help a bot build a useful lead.
    const sizes=new Map(SUITS.map(s=>[s,g.hands[seat].filter(c=>suit(c)===s).length]));
    return [...legal].sort((a,b)=>sizes.get(suit(b))-sizes.get(suit(a))||rank(b)-rank(a))[0];
  }
  const current=winningSeat(g.trick,g.contract.trump);
  const partnerIsWinning=g.contract.declarer!==seat && current!==g.contract.declarer && current!==seat;
  const winning=legal.filter(c=>winningSeat([...g.trick,{seat,card:c}],g.contract.trump)===seat);
  if(!preferLosing && !partnerIsWinning && winning.length)return weakest(winning)[0];
  return weakest(legal)[0];
}
export function botMove(g){
  const seat=g.turn;
  if(!Number.isInteger(seat)||!g.players[seat]?.bot)return false;
  const hand=g.hands[seat];
  switch(g.phase){
    case 'auction':{
      const auction=g.auction;
      if(auction.hand){auctionAction(g,seat,'pass');break;}
      const power=strength(hand);
      const ceiling=power>=23?5:power>=17?4:power>=12?3:power>=8?2:1;
      if(auction.highSeat===null){
        auctionAction(g,seat,power>=8?'bid':'pass',power>=8?2:undefined);
      }else if(auction.highSeat!==seat && auction.priority===seat && auction.bid<=ceiling){
        auctionAction(g,seat,'mogu');
      }else if(auction.bid<ceiling){
        auctionAction(g,seat,'bid',auction.bid+1);
      }else auctionAction(g,seat,'pass');
      break;
    }
    case 'talon':takeTalon(g,seat);break;
    case 'discard':{
      const ranked=weakest(hand);
      // Keep aces and long suits where possible. Discard the weakest two.
      const picks=[...ranked].sort((a,b)=>rank(a)-rank(b)||
        hand.filter(c=>suit(c)===suit(a)).length-hand.filter(c=>suit(c)===suit(b)).length);
      discard(g,seat,picks.slice(0,2));
      break;
    }
    case 'contract':declare(g,seat,g.contract.minimum);break;
    case 'following':{
      const trump=g.contract.trump;
      const trumps=trump?hand.filter(c=>suit(c)===trump).length:0;
      const defend=trumps>=2 || highCardPoints(hand)>=8 || g.contract.value===2;
      follow(g,seat,defend?'dodjem':'ne');
      break;
    }
    case 'calling':{
      // Invite only when the defender needs the partner's tricks.
      callPartner(g,seat,highCardPoints(hand)<9);
      break;
    }
    case 'doubles':{
      const legal=allowedDoubles(g,seat);
      if(!legal.length)throw Error('Bot has no double action.');
      const action=legal.includes('kontra') && (g.contract.value===2 || strength(hand)>=20)
        ? 'kontra':'ok';
      doubleAction(g,seat,action);
      break;
    }
    case 'playing':playCard(g,seat,chooseCard(g,seat));break;
    default:return false;
  }
  return true;
}
