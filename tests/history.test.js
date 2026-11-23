import test from 'node:test';
import assert from 'node:assert/strict';
import {mergeHistory,leaderboard,normalizeRecord,saveHistory,loadHistory} from '../history.js';

const rows=[
 {id:'match-00001',at:'2026-11-23T15:00:00.000Z',rounds:9,players:[{name:'Ana',score:300},{name:'Boris',score:800},{name:'Cene',score:950}]},
 {id:'match-00002',at:'2026-11-24T15:00:00.000Z',rounds:12,players:[{name:'ANA',score:1000},{name:'Dora',score:400},{name:'Boris',score:600}]}
];
test('completed games are deduplicated and sorted newest first',()=>{
 const history=mergeHistory([rows[0]],[rows[0],rows[1]]);
 assert.equal(history.length,2);
 assert.equal(history[0].id,'match-00002');
 assert.equal(mergeHistory(history,history).length,2);
});
test('leaderboard adds scores by case-insensitive friend name',()=>{
 const board=leaderboard(rows);
 assert.deepEqual(board.map(r=>[r.name,r.games,r.total,r.wins]),[
  ['Dora',1,400,1],['Cene',1,950,0],['Boris',2,1400,0],['ANA',2,1300,1]
 ].sort((a,b)=>a[2]-b[2])); 
 assert.equal(board.find(p=>p.name.toLowerCase()==='ana').total,1300);
 assert.equal(board.find(p=>p.name.toLowerCase()==='ana').wins,1);
});
test('invalid or forged-looking scores and duplicate player identities are ignored',()=>{
 assert.equal(normalizeRecord({...rows[0],players:[...rows[0].players.slice(0,2),{name:'ana',score:10}]}),null);
 assert.equal(normalizeRecord({...rows[0],players:[...rows[0].players.slice(0,2),{name:'E',score:NaN}]}),null);
 assert.equal(normalizeRecord({...rows[0],id:'../traversal'}),null);
 assert.equal(normalizeRecord(rows[0]).players.length,3);
});
