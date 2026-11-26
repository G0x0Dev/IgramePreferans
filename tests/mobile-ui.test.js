import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createGame,makeDeck,deal,auctionAction,viewFor,takeTalon,discard,declare} from '../game.js';

const app=readFileSync(new URL('../public/app.js',import.meta.url),'utf8');
const css=readFileSync(new URL('../public/styles.css',import.meta.url),'utf8');

test('browser source parses and keeps normal card click actions',()=>{
  assert.doesNotThrow(()=>new Function(app));
  assert.match(app,/root\.addEventListener\('click'/);
  assert.match(app,/closest\('\[data-card\]'\)/);
  assert.match(app,/state\.legal\.includes\(card\)/);
  assert.match(app,/selected\.includes\(c\)/);
});
test('mobile hand overlaps complete cards rather than requiring horizontal scrolling',()=>{
  assert.match(app,/class="hand-card-slot/);
  assert.match(app,/--card-index:\$\{i\+1\}/);
  assert.match(app,/class="hand" aria-label="Your playing cards"/);
  assert.match(css,/\.hand-card-slot\{display:contents\}/);
  assert.match(css,/@media\(max-width:600px\)/);
  assert.match(css,/\.hand-card-slot\{display:block;position:relative;flex:0 1 60px/);
  assert.match(css,/\.hand-card-slot:last-child\{flex-shrink:0\}/);
  assert.match(css,/\.hand-card-slot \.playing-card\{position:absolute/);
  assert.match(css,/\.hand-card-slot\.is-selected,\.hand-card-slot:focus-within\{z-index:100\}/);
  assert.match(css,/\.hand\{width:100%;min-height:110px;[\s\S]*?overflow:visible\}/);
});
test('the active table is free of the rules/help panel and long instructions',()=>{
  assert.doesNotMatch(app,/class="panel panel-pad rules-link"/);
  assert.doesNotMatch(app,/Bid to begin the round/);
  assert.doesNotMatch(app,/score-key">Lower final scores/);
  assert.match(app,/body=body\.replace\(\/<div class="actions-subtitle">/);
  assert.match(app,/class="bid-status">Current:/);
  assert.match(app,/class="result-summary"/);
});
test('Dalje, Igra Betl and Igra Sans have visible distinct action styles',()=>{
  assert.match(app,/button\('Dalje','pass',\{variant:'pass-action'\}\)/);
  assert.match(app,/button\('Igra Betl','hand',\{value:6,variant:'igra-betl'\}\)/);
  assert.match(app,/button\('Igra Sans','hand',\{value:7,variant:'igra-sans'\}\)/);
  for(const className of ['pass-action','igra-betl','igra-sans']){
    assert.match(css,new RegExp('\\.button\\.'+className+'\\{'));
  }
  assert.match(css,/\.auction-bid-line\{display:grid;grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('touchscreen playable cards do not cast overlapping or sticky hover shadows',()=>{
  const hoverRuleStart=css.indexOf('/* Hover lift is for mouse / trackpad only.');
  assert.ok(hoverRuleStart>=0,'hover-only card lift documented');
  const beforeHoverFix=css.slice(0,hoverRuleStart);
  assert.doesNotMatch(beforeHoverFix,/\.hand \.playing-card:hover:not\(\.disabled\)\{/,
    'no unconditional hover rule should lift a card on mobile touch');
  const fixes=css.slice(hoverRuleStart);
  assert.match(fixes,/@media \(hover:hover\) and \(pointer:fine\)\{/,
    'hover lift is restricted to accurate hover pointers');
  assert.match(fixes,/\.hand \.hand-card-slot \.playing-card,\s*\.hand \.hand-card-slot \.playing-card:hover:not\(\.disabled\)\s*\{\s*box-shadow:none;/,
    'overlapping mobile cards do not cast stacked drop shadows');
  assert.match(fixes,/\.hand \.hand-card-slot \.playing-card\[role="button"\]:not\(\.selected\)\{/,
    'legal clickable cards use an outline');
  assert.match(fixes,/\.hand \.hand-card-slot \.playing-card\.selected,\s*\.hand \.hand-card-slot \.playing-card\.selected:hover:not\(\.disabled\)\{/,
    'selected cards remain raised and visible without a hover shadow');
  assert.match(fixes,/\.playing-card\[role="button"\]:focus-visible\{/,
    'keyboard focus still has a visible accessible outline');
});

test('mobile top navigation respects the safe-area inset and has compact height',()=>{
  assert.match(css,/\.app\{\s*padding-top:calc\(env\(safe-area-inset-top, 0px\) \+ 8px\);/,
    'phone notch and status bar should not cover the header');
  assert.match(css,/\.topbar\{\s*min-height:40px;/,
    'mobile header no longer consumes excessive space');
  assert.match(css,/\.top-actions \.button\{font-size:10px;min-height:34px;/,
    'navigation buttons remain tappable in the compact header');
});
test('mobile game buttons dock at bottom within thumb reach, while desktop stays unchanged',()=>{
  assert.match(app,/class="panel game-stage\$\{mobileDock\?' has-mobile-dock':''\}"/,
    'only the active player gets a mobile action dock');
  assert.match(app,/\['auction','igraReveal','talon','discard','contract','following','calling','doubles'\]\.includes\(state\.phase\)/);
  assert.match(app,/\$\{table\(playedCard\)\}\$\{hand\(\)\}\$\{actionPanel\(\)\}/,
    'original desktop table, hand, actions DOM ordering is preserved');
  assert.match(css,/@media\(max-width:600px\)\{[\s\S]*?\.game-stage\{display:flex;flex-direction:column\}/);
  const dockStyles=css.slice(css.indexOf('/* Thumb-first mobile controls:'));
  assert.ok(dockStyles.length>1500);
  assert.match(dockStyles,/\.game-stage>\.table-wrap\{order:1;/);
  assert.match(dockStyles,/\.game-stage>\.my-hand-area\{order:2\}/);
  assert.match(dockStyles,/\.game-stage>\.actions\{\s*order:3;/);
  assert.match(dockStyles,/\.game-stage\.has-mobile-dock>\.actions\{\s*position:fixed;/);
  assert.match(dockStyles,/bottom:0;/,'dock must sit at the bottom of the screen');
  assert.match(dockStyles,/env\(safe-area-inset-bottom,0px\)/,
    'dock stays above the phone home indicator');
  assert.match(dockStyles,/max-height:62dvh;/,'dock does not occupy the whole viewport');
  assert.match(dockStyles,/overflow-y:auto;/,'short screens can scroll within the dock if necessary');
  assert.match(dockStyles,/\.game-stage\.has-mobile-dock\{\s*padding-bottom:/,
    'the table and cards can scroll above the floating panel');
  assert.match(dockStyles,/\.game-stage\.has-mobile-dock \.auction-bid-line\{[\s\S]*?grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});
test('round result buttons and voting show above reports on mobile',()=>{
  assert.match(css,/\.game-stage\[data-phase="summary"\]>\.actions\{display:flex;flex-direction:column;gap:6px\}/);
  assert.match(css,/\.game-stage\[data-phase="summary"\]>\.actions>\.action-row,[\s\S]*?order:-3\}/);
  assert.match(css,/\.game-stage\[data-phase="summary"\]>\.actions>\.settlement-offer\{order:-2\}/);
  assert.match(css,/\.game-stage\[data-phase="summary"\]>\.actions>\.result-summary\{order:1;/);
});

test('table badges show each player’s highest bid, or Dalje if they only passed',()=>{
  const start=app.indexOf('  function auctionChoiceFor(');
  const end=app.indexOf('  function playerPlace(',start);
  assert.ok(start>0&&end>start,'auction label helper exists');
  const names=['Pik','Karo','Herc','Tref','Betl','Sans'];
  const contractName=value=>names[value-2]||'?';
  const fn=new Function('contractName',app.slice(start,end)+';return auctionChoiceFor;')(contractName);
  const g={phase:'auction',auction:{history:[
    {seat:1,action:'bid',value:2},
    {seat:2,action:'igra',value:null},
    {seat:0,action:'pass',value:null}
  ]}};
  assert.deepEqual(fn(g,1),{label:'Pik',kind:'bid'});
  assert.deepEqual(fn(g,2),{label:'Igra',kind:'igra'});
  assert.deepEqual(fn(g,0),{label:'Dalje',kind:'pass'});
  g.auction.history.push({seat:1,action:'bid',value:3});
  assert.deepEqual(fn(g,1),{label:'Karo',kind:'bid'},'highest bid is shown');
  g.auction.history.push({seat:0,action:'hand',value:6});
  assert.deepEqual(fn(g,0),{label:'Igra Betl',kind:'igra'});
  g.phase='igraReveal';
  g.auction.igraDeclarations=[{seat:2,value:5}];
  assert.deepEqual(fn(g,2),{label:'Igra Tref',kind:'igra'});
  g.auction.igraDeclarations=[{seat:2,value:null,weaker:true}];
  assert.deepEqual(fn(g,2),{label:'Moja je manja',kind:'weaker'});
  g.phase='playing';
  assert.deepEqual(fn(g,2),{label:'Moja je manja',kind:'weaker'},
    'bidding result stays beside the player through card play');
  g.auction.history.push({seat:1,action:'pass',value:null});
  assert.deepEqual(fn(g,1),{label:'Karo',kind:'bid'},
    'a later pass does not replace the highest bid');
  assert.deepEqual(fn(g,0),{label:'Igra Betl',kind:'igra'});
  g.phase='summary';
  assert.deepEqual(fn(g,1),{label:'Karo',kind:'bid'},
    'highest bid stays visible until the next round starts');
  assert.equal(fn({phase:'auction',auction:null},1),null);
  const none={phase:'auction',auction:{history:[{seat:0,action:'bid',value:2}]}};
  assert.equal(fn(none,2),null,'do not falsely mark an unacted player as Dalje');
  none.auction.history.push({seat:2,action:'pass',value:null});
  assert.deepEqual(fn(none,2),{label:'Dalje',kind:'pass'});
  const moje={phase:'auction',auction:{history:[
    {seat:0,action:'bid',value:2},
    {seat:1,action:'mogu',value:null},
    {seat:0,action:'bid',value:3},
    {seat:1,action:'pass',value:null}
  ]}};
  assert.deepEqual(fn(moje,1),{label:'Pik',kind:'bid'},
    'Moje keeps the contract value at the moment it was claimed');
  moje.auction.history.push({seat:2,action:'hand',value:6});
  assert.deepEqual(fn(moje,2),{label:'Igra Betl',kind:'igra'});
  const peak={phase:'auction',auction:{history:[
    {seat:0,action:'bid',value:2},{seat:0,action:'bid',value:3},
    {seat:0,action:'bid',value:4},{seat:0,action:'pass',value:null}
  ]}};
  assert.deepEqual(fn(peak,0),{label:'Herc',kind:'bid'},
    'show the strongest ordinary contract even after Dalje');
  assert.ok(app.includes('class="auction-choice'),'seat badges are rendered');
  assert.ok(css.includes('.seat .auction-choice{'),'seat badges have table styling');
});
test('real losing bidders keep their highest contract beside their seat after auction ends',()=>{
  const g=createGame();
  g.players=['Anna','Bo','Cem'].map(name=>({name,online:true}));
  deal(g,makeDeck());
  const first=g.turn;
  auctionAction(g,g.turn,'bid',2); // first bidder: Pik
  const second=g.turn;
  auctionAction(g,g.turn,'bid',3); // second bidder: Karo
  const third=g.turn;
  auctionAction(g,g.turn,'bid',4); // third bidder: Herc
  auctionAction(g,g.turn,'pass');
  auctionAction(g,g.turn,'pass');
  assert.equal(g.phase,'talon');
  assert.equal(g.contract.declarer,third);
  const names=['Pik','Karo','Herc','Tref','Betl','Sans'];
  const contractName=value=>names[value-2]||'?';
  const start=app.indexOf('  function auctionChoiceFor(');
  const end=app.indexOf('  function playerPlace(',start);
  const label=new Function('contractName',app.slice(start,end)+';return auctionChoiceFor;')(contractName);
  for(const seat of [first,second,third]){
    const view=viewFor(g,seat,'FRIENDS');
    assert.deepEqual(label(view,first),{label:'Pik',kind:'bid'},
      'first losing player must still display Pik, not Dalje or the winning Herc');
    assert.deepEqual(label(view,second),{label:'Karo',kind:'bid'},
      'second losing player must still display Karo, not Dalje or the winning Herc');
    assert.deepEqual(label(view,third),{label:'Herc',kind:'bid'});
  }
  takeTalon(g,third);
  discard(g,third,g.hands[third].slice(0,2));
  declare(g,third,4);
  assert.equal(g.phase,'following');
  const view=viewFor(g,second,'FRIENDS');
  assert.deepEqual(label(view,first),{label:'Pik',kind:'bid'});
  assert.deepEqual(label(view,second),{label:'Karo',kind:'bid'},
    'loser maximum remains visible during defense decisions and later card play');
});
test('each new trick card drops once, without replaying on normal state updates',()=>{
  const start=app.indexOf('  function freshPlayedCard(');
  const end=app.indexOf("  socket.on('state',g=>",start);
  assert.ok(start>0&&end>start,'animation tracking helper exists');
  const fresh=new Function(app.slice(start,end)+';return freshPlayedCard;')();
  const first={seat:0,card:'S7'};
  const second={seat:1,card:'S8'};
  const previous={round:2,phase:'playing',trick:[first]};
  const next={round:2,phase:'playing',trick:[first,second]};
  assert.deepEqual(fresh(previous,next),second);
  assert.equal(fresh(next,next),null,'do not animate a card again on a repeat update');
  assert.equal(fresh(null,next),null,'reconnecting must not animate every card');
  assert.equal(fresh({...previous,round:1},next),null,'changing rounds must not trigger animation');
  assert.equal(fresh({...previous,trick:[second]},next),null,'replaced trick is not a new card');
  assert.deepEqual(fresh(previous,{...next,phase:'summary'}),second,
    'last played Betl card also animates before the immediate summary');
  assert.ok(app.includes('render(newlyPlayed);'));
  assert.ok(app.includes("incoming?' incoming':''"));
  assert.ok(css.includes('.played.incoming .playing-card{'));
  assert.ok(css.includes('@keyframes card-drop-on-felt{'));
  assert.ok(css.includes('.played.incoming .playing-card{animation:none;'),
    'reduced-motion users should not receive card animations');
});

test('score controls include protected reset and manual-only backup restore',()=>{
  assert.match(app,/button\('Reset all scores','resetScores'/);
  assert.match(app,/case 'resetScores':\{/);
  assert.match(app,/RESET ALL SCORES/);
  assert.match(app,/socket\.emit\('resetScores',\{adminSecret,confirmation\}/);
  assert.match(app,/case 'importHistory':\{/);
  assert.match(app,/socket\.emit\('restoreHistory',\{records,adminSecret\}/);
  assert.doesNotMatch(app,/historyRestoreTried/);
  assert.doesNotMatch(app,/if\(Array\.isArray\(saved\)&&saved\.length\)socket\.emit\('restoreHistory'/,
    'an empty archive must never refill itself from old browser copies');
  assert.match(app,/savedEpoch&&savedEpoch!==g\.historyEpoch/);
  assert.match(app,/localStorage\.removeItem\(HISTORY_KEY\)/);
  assert.doesNotMatch(app,/localStorage\.setItem\('ADMIN_RESET_SECRET'/,
    'administrator password must not be stored in a browser');
});

test('Karo diamond symbol sits above the bid label on all screen sizes',()=>{
  assert.match(app,/button\(next\.n,'bid',\{value:next\.v,extra:icon\(next\),variant:'suit-bid'\}\)/);
  assert.match(app,/allowed\.map\(c=>button\(c\.n,'igraDeclare',\{value:c\.v,extra:icon\(c\),variant:'suit-bid'\}\)\)/);
  assert.ok(app.includes("D:'♦'"),'Diamonds use the real diamond glyph');
  assert.match(css,/\.button\.suit-bid\{[\s\S]*?flex-direction:column;/);
  assert.match(css,/\.button\.suit-bid \.suit-symbol\{[\s\S]*?display:block;/);
  assert.match(css,/\.game-stage\.has-mobile-dock \.auction-bid-line \.button\.suit-bid\{/);
});
test('defensive actions have no Will you defend heading; Imam želju is a Ne choice',()=>{
  assert.doesNotMatch(app,/Will you defend\?/);
  assert.match(app,/button\('Imam želju','followWish'\)/);
  assert.match(app,/case 'followWish':send\('follow',\{choice:'imam-zelju'\}\)/);
  assert.match(css,/\.game-stage\[data-phase="following"\] \.actions \.action-row\{/);
  assert.match(css,/grid-template-columns:repeat\(2,minmax\(0,1fr\)\)/);
});

test('Mogu is displayed as Moje; passing displays only Dalje',()=>{
  assert.match(app,/button\('Moje '\+a\.bid,'mogu',\{variant:'active'\}\)/,
    'existing priority action is relabeled, not changed mechanically');
  assert.match(app,/button\('Dalje','pass',\{variant:'pass-action'\}\)/);
  assert.doesNotMatch(app,/Dalje · Pass|button\('Mogu '/);
});
