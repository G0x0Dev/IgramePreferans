import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

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
  assert.match(app,/button\('Dalje · Pass','pass',\{variant:'pass-action'\}\)/);
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
