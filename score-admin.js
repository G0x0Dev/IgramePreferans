/** Constant-time authentication for score administration. */
import {createHash,timingSafeEqual} from 'node:crypto';

export function requireScoreAdmin(provided,configured){
  if(typeof configured!=='string'||configured.length<16)
    throw new Error('ADMIN_RESET_SECRET is not configured (minimum 16 characters).');
  if(typeof provided!=='string'||provided.length>256)
    throw new Error('Invalid administrator password.');
  const actual=createHash('sha256').update(configured).digest();
  const candidate=createHash('sha256').update(provided).digest();
  if(!timingSafeEqual(actual,candidate))
    throw new Error('Invalid administrator password.');
  return true;
}
export function checkResetAllowed(game,confirmation){
  if(confirmation!=='RESET ALL SCORES')
    throw new Error('Type RESET ALL SCORES to confirm deleting saved results.');
  if(game.phase!=='lobby' && !(game.phase==='summary'&&game.finished))
    throw new Error('Finish the current match before resetting all saved scores.');
  return true;
}
