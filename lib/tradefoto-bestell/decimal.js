'use strict';
const C=require('../data-import-contract');
function parse(value){if(typeof value!=='string'||!/^(-?)(\d{1,309})(?:\.(\d{1,324}))?$/u.test(value))C.fail('IMPORT_SOURCE_DECIMAL_INVALID');
  const [whole,fraction='']=value.split('.');return {n:BigInt(whole+fraction),scale:fraction.length};}
function render(n,scale){const sign=n<0n?'-':'',digits=(n<0n?-n:n).toString().padStart(scale+1,'0');
  const result=scale?digits.slice(0,-scale)+'.'+digits.slice(-scale):digits;return sign+(result.includes('.')?result.replace(/0+$/u,'').replace(/\.$/u,''):result);}
function align(a,b){const x=parse(a),y=parse(b),scale=Math.max(x.scale,y.scale);return {a:x.n*10n**BigInt(scale-x.scale),b:y.n*10n**BigInt(scale-y.scale),scale};}
function add(a,b){const x=align(a,b);return render(x.a+x.b,x.scale);}
function subtract(a,b){const x=align(a,b);return render(x.a-x.b,x.scale);}
function compare(a,b){const x=align(a,b);return x.a<x.b?-1:x.a>x.b?1:0;}
function multiply(a,b){const x=parse(a),y=parse(b);return render(x.n*y.n,x.scale+y.scale);}
function divide(a,b,places=6){if(!Number.isSafeInteger(places)||places<0||places>12)C.fail('IMPORT_DECIMAL_PRECISION');const x=parse(a),y=parse(b);if(y.n===0n)return null;
  const n=x.n*10n**BigInt(y.scale+places),d=y.n*10n**BigInt(x.scale),sign=(n<0n)!==(d<0n)?-1n:1n,an=n<0n?-n:n,ad=d<0n?-d:d;
  return render(sign*((an+ad/2n)/ad),places);}
module.exports={parse,render,add,subtract,compare,multiply,divide};
