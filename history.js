/** Small shared match archive. This module contains only public scores, never private cards. */
import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const MAX_HISTORY=200;
const file=process.env.HISTORY_FILE || join(process.env.DATA_DIR || process.cwd(), 'preferans-results.json');

export function normalizeRecord(value){
  if(!value || typeof value!=='object' || Array.isArray(value))return null;
  if(typeof value.id!=='string' || !/^[a-zA-Z0-9_-]{8,80}$/.test(value.id))return null;
  if(typeof value.at!=='string' || !Number.isFinite(Date.parse(value.at)) || value.at.length>32)return null;
  if(!Array.isArray(value.players) || value.players.length!==3)return null;
  const players=value.players.map(p=>{
    if(!p || typeof p!=='object' || typeof p.name!=='string')return null;
    const name=p.name.trim();
    if(!name || name.length>24 || !Number.isSafeInteger(p.score) || Math.abs(p.score)>1_000_000)return null;
    return {name,score:p.score};
  });
  if(players.some(p=>p===null))return null;
  if(new Set(players.map(p=>p.name.toLowerCase())).size!==3)return null;
  const rounds=Number.isSafeInteger(value.rounds)&&value.rounds>=1&&value.rounds<=10000?value.rounds:1;
  return {id:value.id,at:new Date(value.at).toISOString(),players,rounds};
}
export function mergeHistory(current,incoming){
  const byId=new Map();
  for(const item of [...current,...(Array.isArray(incoming)?incoming:[])]){
    const record=normalizeRecord(item);
    if(record && !byId.has(record.id))byId.set(record.id,record);
  }
  return [...byId.values()].sort((a,b)=>Date.parse(b.at)-Date.parse(a.at)||a.id.localeCompare(b.id)).slice(0,MAX_HISTORY);
}
export function loadHistory(){
  try{
    const saved=JSON.parse(readFileSync(file,'utf8'));
    return mergeHistory([],Array.isArray(saved)?saved:saved.records);
  }catch(e){
    if(e.code!=='ENOENT')console.warn('Could not load score archive:',e.message);
    return [];
  }
}
export function saveHistory(records){
  try{
    mkdirSync(dirname(file),{recursive:true});
    const tmp=file+'.tmp';
    writeFileSync(tmp,JSON.stringify({version:1,records:mergeHistory([],records)},null,2),'utf8');
    renameSync(tmp,file);
    return true;
  }catch(e){console.error('Could not persist score archive:',e.message);return false;}
}
export function leaderboard(history){
  const totals=new Map();
  for(const record of mergeHistory([],history)){
    const winner=Math.min(...record.players.map(p=>p.score));
    for(const p of record.players){
      const id=p.name.toLocaleLowerCase();
      let row=totals.get(id);
      if(!row){row={name:p.name,games:0,total:0,wins:0};totals.set(id,row);}
      row.games++;row.total+=p.score;
      if(p.score===winner)row.wins++;
    }
  }
  return [...totals.values()].sort((a,b)=>a.total-b.total||b.wins-a.wins||a.name.localeCompare(b.name)).map((p,i)=>({...p,position:i+1}));
}
