import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,readdir,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {sources,prepareCards} from '../scripts/prepare-cards.js';
import {makeDeck} from '../game.js';

test('every Preferans card maps to a distinct historical North-German image',()=>{
  assert.equal(sources.length,32);
  assert.deepEqual(sources.map(s=>s.card).sort(),makeDeck().sort());
  assert.equal(new Set(sources.map(s=>s.original)).size,32);
  assert.equal(sources.find(s=>s.card==='HQ').filename,'Dama_Kier_z_Wzoru_Berlińskiego.png');
  assert.equal(sources.find(s=>s.card==='DK').filename,'Król_Karo_z_Wzoru_Berlińskiego.png');
  assert.ok(sources.every(s=>s.thumbnail.startsWith('https://upload.wikimedia.org/wikipedia/commons/thumb/')));
});
test('artwork installer caches all valid images locally and skips existing images',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'preferans-cards-'));
  try{
    // Small synthetic PNG header for exercising validation and atomic writes.
    const png=Buffer.alloc(32);
    Buffer.from([137,80,78,71,13,10,26,10]).copy(png);
    png.writeUInt32BE(250,16);png.writeUInt32BE(390,20);
    let calls=0;
    const fetcher=async()=>{calls++;return {ok:true,arrayBuffer:async()=>png};};
    const logger={log(){},warn(){}};
    assert.deepEqual(await prepareCards({directory:dir,fetcher,logger}),[]);
    assert.equal(calls,32);
    assert.equal((await readdir(dir)).length,32);
    assert.deepEqual(await readFile(join(dir,'SA.png')),png);
    assert.deepEqual(await prepareCards({directory:dir,fetcher,logger}),[]);
    assert.equal(calls,32,'cached files must not download again');
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('unavailable or invalid artwork never becomes a broken local PNG',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'preferans-cards-failed-'));
  try{
    const logger={log(){},warn(){}};
    const fetcher=async()=>({ok:true,arrayBuffer:async()=>Buffer.from('<html>Error</html>')});
    const failed=await prepareCards({directory:dir,fetcher,logger});
    assert.equal(failed.length,32);
    assert.deepEqual(await readdir(dir),[]);
  }finally{await rm(dir,{recursive:true,force:true});}
});
