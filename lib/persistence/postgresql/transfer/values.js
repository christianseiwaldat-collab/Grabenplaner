'use strict';
const crypto=require('node:crypto');

function decimal(value) {
  const match=/^(-?)(\d+)(?:\.(\d*))?(?:[eE]([+-]?\d+))?$/.exec(String(value));
  if(!match)throw new Error('MIGRATION_DECIMAL_INVALID');
  const exponent=Number(match[4]||0);if(!Number.isSafeInteger(exponent)||Math.abs(exponent)>100)throw new Error('MIGRATION_DECIMAL_RANGE');
  let digits=match[2]+(match[3]||''),point=match[2].length+exponent;
  if(point<0){digits='0'.repeat(-point)+digits;point=0;}
  if(point>digits.length)digits+='0'.repeat(point-digits.length);
  const whole=(digits.slice(0,point)||'0').replace(/^0+(?=\d)/,'');
  const fraction=digits.slice(point).replace(/0+$/,'');
  if(whole.length>18||fraction.length>12)throw new Error('MIGRATION_DECIMAL_PRECISION');
  const sign=match[1]&&(whole!=='0'||fraction)?'-':'';
  return sign+whole+'.'+fraction.padEnd(12,'0');
}

function valueFor(column,value) {
  if(value===null)return null;
  switch(column.kind) {
    case 'integer': {
      if(typeof value==='number'&&!Number.isSafeInteger(value))throw new Error('MIGRATION_INTEGER_PRECISION');
      if(!/^-?\d+$/.test(String(value)))throw new Error('MIGRATION_INTEGER_INVALID');
      const n=BigInt(value);if(n<-(2n**63n)||n>2n**63n-1n)throw new Error('MIGRATION_INTEGER_RANGE');
      return n.toString();
    }
    case 'decimal': return decimal(value);
    case 'real': {
      if(typeof value==='string'&&!/^[+-]?\d+(?:\.\d*)?(?:[eE][+-]?\d+)?$/.test(value))throw new Error('MIGRATION_REAL_INVALID');
      const n=Number(value);if(!Number.isFinite(n)||!['bigint','number','string'].includes(typeof value))throw new Error('MIGRATION_REAL_INVALID');
      if(typeof value==='bigint'&&BigInt(n)!==value)throw new Error('MIGRATION_REAL_PRECISION');
      return n===0?0:n;
    }
    case 'blob': {
      if(!ArrayBuffer.isView(value))throw new Error('MIGRATION_BLOB_INVALID');
      return Buffer.from(value.buffer,value.byteOffset,value.byteLength);
    }
    case 'text':
      if(typeof value!=='string'||value.includes('\0')||Buffer.from(value).toString('utf8')!==value)throw new Error('MIGRATION_TEXT_INVALID');
      return value;
    default: throw new Error('MIGRATION_TYPE_UNREVIEWED');
  }
}

function createRowDigest(columns) {
  const hash=crypto.createHash('sha256');let rows=0;
  hash.update(JSON.stringify(columns.map(c=>({name:c.name,kind:c.kind})))+'\n');
  return {
    add(values) {
      if(values.length!==columns.length)throw new Error('MIGRATION_ROW_SHAPE');
      const normalized=values.map((value,i)=>valueFor(columns[i],value));
      const encoded=normalized.map((value,i)=>{
        if(value===null)return null;
        if(columns[i].kind==='blob')return value.toString('hex');
        if(columns[i].kind==='real'){const b=Buffer.allocUnsafe(8);b.writeDoubleBE(value);return b.toString('hex');}
        return value;
      });
      hash.update(JSON.stringify(encoded)+'\n');rows++;return normalized;
    },
    finish(){return {rows,sha256:hash.digest('hex')};},
  };
}
module.exports={decimal,valueFor,createRowDigest};
