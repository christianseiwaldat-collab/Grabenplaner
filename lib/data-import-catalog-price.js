'use strict';
// Access DOUBLE source text remains unchanged in the authenticated master data.
// Only its monetary catalog projection uses NUMERIC(30,12), with explicit
// decimal half-up rounding. Never round via binary floating point or cents.
const ADAPTATION_VERSION='db2-decimal12-half-up';
function catalogPrice(value) {
  if(typeof value!=='string') return value;
  const match=/^(0|[1-9]\d{0,17})\.(\d{13,324})$/u.exec(value);
  if(!match) return value; // Negatives, invalid text and overflow keep their gate.
  const scale=1000000000000n,head=BigInt(match[1])*scale+BigInt(match[2].slice(0,12));
  const rounded=head+(match[2][12]>='5'?1n:0n);
  // A positive source amount must not silently become a zero/free price.
  if(rounded===0n && /[1-9]/u.test(match[2])) return value;
  const whole=String(rounded/scale);
  if(whole.length>18)return value;
  return whole+'.'+String(rounded%scale).padStart(12,'0');
}
module.exports={catalogPrice,ADAPTATION_VERSION};
