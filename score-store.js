/** Durable public score archive. Never stores hands, card secrets, or admin passwords. */
import { randomBytes } from 'node:crypto';
import { loadHistory,saveHistory,mergeHistory,normalizeRecord } from './history.js';

const newEpoch=()=>randomBytes(16).toString('hex');
const validRecord=value=>{
  const record=normalizeRecord(value);
  if(!record)throw new Error('Invalid score record in backup.');
  return record;
};

export function fileScoreStore(){
  let epoch=newEpoch();
  return {
    kind:'file',
    async load(){return {history:loadHistory(),epoch};},
    async add(record){
      const combined=mergeHistory(loadHistory(),[validRecord(record)]);
      if(!saveHistory(combined))throw new Error('Failed to write local score file.');
    },
    async importRecords(records){
      if(!saveHistory(mergeHistory(loadHistory(),records.map(validRecord))))
        throw new Error('Failed to write local score file.');
    },
    async reset(){
      if(!saveHistory([]))throw new Error('Failed to clear local score file.');
      epoch=newEpoch();return epoch;
    }
  };
}

// A separate factory permits database integration tests with an in-memory query
// adapter; only connectScoreStore imports the production PostgreSQL driver.
export async function postgresScoreStore(pool){
  await pool.query(`CREATE TABLE IF NOT EXISTS preferans_score_matches (
    id TEXT PRIMARY KEY,
    played_at TIMESTAMPTZ NOT NULL,
    record JSONB NOT NULL
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS preferans_score_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`);
  await pool.query('INSERT INTO preferans_score_meta (key,value) VALUES ($1,$2) ON CONFLICT (key) DO NOTHING',
    ['reset_epoch',newEpoch()]);
  return {
    kind:'postgres',
    async load(){
      const [matches,meta]=await Promise.all([
        pool.query('SELECT record FROM preferans_score_matches ORDER BY played_at DESC,id ASC'),
        pool.query('SELECT value FROM preferans_score_meta WHERE key=$1',['reset_epoch'])
      ]);
      return {history:mergeHistory([],matches.rows.map(row=>row.record)),
        epoch:meta.rows[0]?.value||''};
    },
    async add(input){
      const record=validRecord(input);
      await pool.query(`INSERT INTO preferans_score_matches (id,played_at,record)
        VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`,
        [record.id,record.at,JSON.stringify(record)]);
    },
    async importRecords(inputs){
      const records=inputs.map(validRecord);
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        for(const record of records)await client.query(
          `INSERT INTO preferans_score_matches (id,played_at,record)
          VALUES ($1,$2,$3::jsonb) ON CONFLICT (id) DO NOTHING`,
          [record.id,record.at,JSON.stringify(record)]);
        await client.query('COMMIT');
      }catch(e){await client.query('ROLLBACK');throw e;}
      finally{client.release();}
    },
    async reset(){
      const epoch=newEpoch();
      const client=await pool.connect();
      try{
        await client.query('BEGIN');
        await client.query('DELETE FROM preferans_score_matches');
        await client.query('UPDATE preferans_score_meta SET value=$2 WHERE key=$1',['reset_epoch',epoch]);
        await client.query('COMMIT');
        return epoch;
      }catch(e){await client.query('ROLLBACK');throw e;}
      finally{client.release();}
    }
  };
}

export async function connectScoreStore(databaseUrl=process.env.DATABASE_URL){
  if(!databaseUrl)return fileScoreStore();
  const {Pool}=await import('pg');
  const pool=new Pool({connectionString:databaseUrl,max:3,connectionTimeoutMillis:12000});
  try{return await postgresScoreStore(pool);}
  catch(e){await pool.end();throw e;}
}
