'use strict';
const fs=require('node:fs'),os=require('node:os');

function systemMemorySummary({platform=process.platform,totalBytes=os.totalmem(),freeBytes=os.freemem(),readMeminfo=()=>fs.readFileSync('/proc/meminfo','utf8')}={}) {
  let availableBytes=freeBytes,availabilitySource='free';
  if(platform==='linux') {
    try {
      const match=/^MemAvailable:\s+(\d+)\s+kB\s*$/m.exec(readMeminfo());
      const bytes=match?Number(match[1])*1024:NaN;
      if(Number.isSafeInteger(bytes)&&bytes>=0&&bytes<=totalBytes){availableBytes=bytes;availabilitySource='mem_available';}
    } catch {}
  }
  return {totalBytes,freeBytes,availableBytes,availabilitySource,
    usedPercent:totalBytes>0?Math.max(0,Math.min(100,Math.round((totalBytes-availableBytes)/totalBytes*100))):null};
}
module.exports={systemMemorySummary};
