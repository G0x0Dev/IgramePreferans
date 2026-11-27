// Historical North-German (Berlin) deck from the public-domain Commons set.
import {createHash} from 'node:crypto';
import {mkdir,writeFile,rename,readFile} from 'node:fs/promises';
import {dirname,join} from 'node:path';
import {fileURLToPath} from 'node:url';

export const ranks={'7':'Siódemka','8':'Ósemka','9':'Dziewiątka','10':'Dziesiątka',J:'Walet',Q:'Dama',K:'Król',A:'As'};
export const suits={S:'Pik',D:'Karo',H:'Kier',C:'Trefl'};
export const sources=Object.entries(suits).flatMap(([s,suit])=>Object.entries(ranks).map(([r,rank])=>{
  const filename=rank+'_'+suit+'_z_Wzoru_Berlińskiego.png';
  const hash=createHash('md5').update(filename).digest('hex');
  const path=hash[0]+'/'+hash.slice(0,2)+'/'+encodeURIComponent(filename);
  return {card:s+r,filename,original:'https://upload.wikimedia.org/wikipedia/commons/'+path,
    thumbnail:'https://upload.wikimedia.org/wikipedia/commons/thumb/'+path+'/250px-'+encodeURIComponent(filename)};
}));
const pngSignature=Buffer.from([137,80,78,71,13,10,26,10]);
const validPng=bytes=>bytes.length>24&&bytes.subarray(0,8).equals(pngSignature)&&bytes.readUInt32BE(16)>0&&bytes.readUInt32BE(20)>0;
async function download(source,fetcher=fetch){
  for(const url of [source.thumbnail,source.original]){
    try{
      const response=await fetcher(url,{
        headers:{'User-Agent':'PreferansOnlineCardAssets/1.0 (https://github.com/G0x0Dev/IgramePreferans)'},
        signal:AbortSignal.timeout(18000)
      });
      if(!response.ok)continue;
      const bytes=Buffer.from(await response.arrayBuffer());
      if(validPng(bytes)&&bytes.length<6_000_000)return bytes;
    }catch{}
  }
  throw new Error('Could not retrieve '+source.card);
}
export async function prepareCards({directory=join(dirname(fileURLToPath(import.meta.url)),'../public/cards/north-german'),fetcher=fetch,logger=console}={}){
  await mkdir(directory,{recursive:true});
  let index=0;
  const failed=[];
  await Promise.all(Array.from({length:4},async()=>{
    while(index<sources.length){
      const source=sources[index++];
      const path=join(directory,source.card+'.png');
      try{if(validPng(await readFile(path)))continue;}catch{}
      try{
        const bytes=await download(source,fetcher);
        await writeFile(path+'.tmp',bytes);
        await rename(path+'.tmp',path);
      }catch{failed.push(source.card);}
    }
  }));
  logger.log('North-German card artwork: '+(sources.length-failed.length)+' / '+sources.length+' available.');
  if(failed.length)logger.warn('Card downloads unavailable for '+failed.join(', ')+'. These cards will use the local fallback design.');
  return failed;
}
if(process.argv[1]&&fileURLToPath(import.meta.url)===process.argv[1]){
  const failed=await prepareCards();
  if(process.argv.includes('--strict')&&failed.length)process.exitCode=1;
}
