/** Pure policy shared by the desktop and CLI. Fresh confirmed identity resets
 * the outage budget, while the last refresh cooldown survives brief recovery. */
export function createConnectionRecovery({now=Date.now,delayMs=60000,cooldownMs=300000,attemptLimit=2}={}){
 let pendingSince=null,attempts=0,nextAt=0,manual=false;
 return {
  observe(result){
   if(result?.authenticated===true){pendingSince=null;attempts=0;manual=false;}
   else if(result?.authenticated===false&&result.verificationPending===true){if(pendingSince===null)pendingSince=now();}
   else{pendingSince=null;manual=false;}
  },
  request(){if(pendingSince!==null)manual=true;},
  takeRecovery(){
   if(pendingSince===null)return false;
   if(!manual&&(attempts>=attemptLimit||now()-pendingSince<delayMs||now()<nextAt))return false;
   if(manual)attempts=0;
   manual=false;attempts++;nextAt=now()+cooldownMs;return true;
  },
  status(){return{pending:pendingSince!==null,attempts,manualRequired:pendingSince!==null&&attempts>=attemptLimit,nextAt:pendingSince===null||attempts>=attemptLimit?null:Math.max(nextAt,pendingSince+delayMs)};},
 };
}
