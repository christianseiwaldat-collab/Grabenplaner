'use strict';
// Technical phase names only. Keep measurements out of signed checkpoint data.
function phaseTimer(onTiming=()=>{}){
 return async function measure(phase,work){
  const started=performance.now();let succeeded=false;
  try{const result=await work();succeeded=true;return result;}
  finally{
   try{onTiming({phase,milliseconds:Math.round(performance.now()-started),succeeded});}
   catch{/* Telemetry must not replace the original operation or its error. */}
  }
 };
}
module.exports={phaseTimer};
