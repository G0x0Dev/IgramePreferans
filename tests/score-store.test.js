import test from 'node:test';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {postgresScoreStore,fileScoreStore} from '../score-store.js';
import {requireScoreAdmin,checkResetAllowed} from '../score-admin.js';
import {mergeHistory} from '../history.js';

const record=(id,score=40)=>({id,at:'2026-11-25T10:00:00.000Z',rounds:3,players:[
  {name:'Ana',score},{name:'Bo',score:50},{name:'Cem',score:60}
]});
function fakePool(){
  const records=new Map();
  let epoch='';
  let transaction=[];
  const log=[];
  const query=async (sql,values=[])=>{
    const normalized=sql.trim().replace(/\s+/g,' ');
    log.push({sql:normalized,values});
    if(normalized.startsWith('CREATE TABLE'))return {rows:[]};
    if(normalized.startsWith('INSERT INTO preferans_score_meta')){
      if(!epoch)epoch=values[1];
      return {rows:[]};
    }
    if(normalized==='BEGIN'){transaction=[];return {rows:[]};}
    if(normalized==='COMMIT'){transaction=[];return {rows:[]};}
    if(normalized==='ROLLBACK'){for(const undo of transaction.reverse())undo();transaction=[];return {rows:[]};}
    if(normalized.startsWith('INSERT INTO preferans_score_matches')){
      if(!records.has(values[0])){
        const id=values[0];records.set(id,JSON.parse(values[2]));
        transaction.push(()=>records.delete(id));
      }
      return {rows:[]};
    }
    if(normalized.startsWith('SELECT record FROM preferans_score_matches')){
      return {rows:[...records.values()].sort((a,b)=>b.at.localeCompare(a.at)).map(record=>({record}))};
    }
    if(normalized.startsWith('SELECT value FROM preferans_score_meta'))
      return {rows:[{value:epoch}]};
    if(normalized.startsWith('DELETE FROM preferans_score_matches')){
      const backup=new Map(records);records.clear();
      transaction.push(()=>{records.clear();for(const [id,r] of backup)records.set(id,r);});
      return {rows:[]};
    }
    if(normalized.startsWith('UPDATE preferans_score_meta')){
      const old=epoch;epoch=values[1];transaction.push(()=>{epoch=old;});
      return {rows:[]};
    }
    throw Error('Unexpected SQL: '+normalized);
  };
  return {query,connect:async()=>({query,release(){}}),records,log};
}
test('Postgres archive saves matches, deduplicates, survives reload and resets permanently',async()=>{
  const pool=fakePool();
  const store=await postgresScoreStore(pool);
  assert.equal((await store.load()).history.length,0);
  const oldEpoch=(await store.load()).epoch;
  await store.add(record('match-0001'));
  await store.add(record('match-0001'));
  await store.importRecords([record('match-0002',20)]);
  assert.deepEqual((await store.load()).history.map(r=>r.id),['match-0001','match-0002']);
  assert.ok(pool.log.some(q=>q.sql.includes('ON CONFLICT (id) DO NOTHING')),
    'SQL must not duplicate a match ID');
  const nextEpoch=await store.reset();
  assert.notEqual(nextEpoch,oldEpoch);
  assert.deepEqual((await store.load()).history,[],'database is empty after reset');
  assert.equal((await store.load()).epoch,nextEpoch);
  assert.ok(pool.log.some(q=>q.sql==='BEGIN'));
  assert.ok(pool.log.some(q=>q.sql==='COMMIT'));
  assert.ok(pool.log.some(q=>q.sql==='DELETE FROM preferans_score_matches'));
  assert.deepEqual(pool.records.size,0);
});
test('bad backups cannot import partial score rows',async()=>{
  const pool=fakePool(),store=await postgresScoreStore(pool);
  await assert.rejects(store.importRecords([record('match-0001'),{...record('match-0002'),players:[]}]),/Invalid score record/);
  assert.deepEqual((await store.load()).history,[]);
});
test('archive contains more than the old 200-match limit',()=>{
  const records=Array.from({length:260},(_,i)=>record('game'+String(i).padStart(8,'0')));
  assert.equal(mergeHistory([],records).length,260);
});
test('administration requires a valid secret and full typed reset confirmation',()=>{
  const secret='a-long-unique-admin-secret-2026';
  assert.equal(requireScoreAdmin(secret,secret),true);
  assert.throws(()=>requireScoreAdmin('wrong',secret),/Invalid administrator password/);
  assert.throws(()=>requireScoreAdmin(secret,''),/not configured/);
  assert.throws(()=>requireScoreAdmin(secret, 'short'),/minimum 16/);
  assert.throws(()=>checkResetAllowed({phase:'playing'},'RESET ALL SCORES'),/Finish the current match/);
  assert.throws(()=>checkResetAllowed({phase:'summary',finished:false},'RESET ALL SCORES'),/Finish the current match/);
  assert.throws(()=>checkResetAllowed({phase:'lobby'},'reset'),/Type RESET ALL SCORES/);
  assert.equal(checkResetAllowed({phase:'lobby'},'RESET ALL SCORES'),true);
  assert.equal(checkResetAllowed({phase:'summary',finished:true},'RESET ALL SCORES'),true);
});
test('server remains syntactically valid with asynchronous score initialization',()=>{
  assert.doesNotThrow(()=>execFileSync(process.execPath,['--check',new URL('../server.js',import.meta.url).pathname]));
});
