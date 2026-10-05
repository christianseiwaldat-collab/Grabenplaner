'use strict';
// Pure projection; the caller retains the complete original source value.
const { parseDocument } = require('htmlparser2');
const LIMITS = Object.freeze({ inputBytes:32768, outputBytes:65536, textBytes:32768, nodes:2000, depth:32 });
const ALLOWED = new Set(['p','div','br','ul','ol','li','strong','b','em','i','u','s','h3','h4',
  'blockquote','pre','code','table','thead','tbody','tfoot','tr','th','td','a']);
const BLOCK = new Set(['p','div','ul','ol','li','h3','h4','blockquote','pre','table','thead','tbody','tfoot','tr']);
const DROP = new Set(['script','style','iframe','frame','frameset','svg','math','object','embed','applet',
  'noscript','noembed','noframes','xmp','plaintext','template','head','title','form','input','button',
  'select','textarea','option','optgroup','datalist','fieldset','legend','output','img','picture',
  'video','audio','source','track','canvas','link','meta','base']);
const escape = value => String(value).replace(/[&<>"']/gu, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function clipUtf8(value, limit) {
  if (Buffer.byteLength(value,'utf8') <= limit) return {value,clipped:false};
  let valueOut='', bytes=0;
  for (const character of value) { const size=Buffer.byteLength(character,'utf8'); if(bytes+size>limit) break; valueOut+=character; bytes+=size; }
  return {value:valueOut,clipped:true};
}
function safeHref(value) {
  if (typeof value !== 'string' || value.length>2048 || /[\u0000-\u0020\u007f]/u.test(value) || !/^https?:\/\//iu.test(value)) return null;
  try { const url=new URL(value); return ['http:','https:'].includes(url.protocol) && !url.username && !url.password ? url.href : null; }
  catch { return null; }
}
function sanitizeArticleDescription(raw) {
  if (typeof raw !== 'string') throw new TypeError('Article description must be text');
  const clipped=clipUtf8(raw.toWellFormed(),LIMITS.inputBytes);
  const document=parseDocument(clipped.value,{xmlMode:false,decodeEntities:true,lowerCaseTags:true,lowerCaseAttributeNames:true,recognizeSelfClosing:false});
  const plainSource=!document.children.some(node=>['tag','script','style'].includes(node.type));
  const chunks=[], preview=[];
  let bytes=0,reserved=0,nodes=0,hasMarkup=false,truncated=clipped.clipped,halted=false;
  function boundary(value) {
    if(preview.at(-1)?.boundary && preview.at(-1).value===value)return;
    preview.push({value,boundary:true});
  }
  function append(value) { chunks.push(value); bytes+=Buffer.byteLength(value,'utf8'); }
  function text(value, preserve) {
    value=value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu,'');
    if(!preserve)value=value.replace(/\s+/gu,' ');
    let encoded='',plain='';
    for(const character of value) {
      const escaped=escape(character),size=Buffer.byteLength(escaped,'utf8');
      if(bytes+reserved+size>LIMITS.outputBytes) { truncated=true;halted=true;break; }
      encoded+=escaped;plain+=character;bytes+=size;
    }
    chunks.push(encoded);preview.push({value:plain,preserve});
  }
  function visit(node,depth,preserve=false) {
    if(halted)return;
    if(++nodes>LIMITS.nodes) { truncated=true;halted=true;return; }
    if(node.type==='text') { text(node.data,preserve);return; }
    if(!['tag','script','style'].includes(node.type))return;
    hasMarkup=true;
    const name=node.name.toLowerCase();
    if(DROP.has(name))return;
    if(depth>LIMITS.depth) { truncated=true;return; }
    let tag=ALLOWED.has(name)?name:null,open='',close='';
    if(tag==='a') {
      const href=safeHref(node.attribs?.href);
      if(href)open='<a href="'+escape(href)+'" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">';
      else tag=null;
    }
    if(tag) {
      open ||= '<'+tag+'>';close=tag==='br'?'':'</'+tag+'>';
      if(bytes+reserved+Buffer.byteLength(open+close,'utf8')>LIMITS.outputBytes) { truncated=true;halted=true;return; }
      append(open);reserved+=Buffer.byteLength(close,'utf8');
    }
    if(tag==='br' || BLOCK.has(tag))boundary('\n');
    if(tag==='li')preview.push({value:'• '});
    for(const child of node.children || [])visit(child,depth+1,preserve || tag==='pre');
    if(tag==='td' || tag==='th')boundary('\t');
    if(BLOCK.has(tag))boundary('\n');
    if(close) { reserved-=Buffer.byteLength(close,'utf8');append(close); }
  }
  for(const node of document.children)visit(node,1,plainSource);
  while(preview[0]?.boundary)preview.shift();
  while(preview.at(-1)?.boundary)preview.pop();
  if(preview[0] && !preview[0].preserve)preview[0].value=preview[0].value.trimStart();
  if(preview.at(-1) && !preview.at(-1).preserve)preview.at(-1).value=preview.at(-1).value.trimEnd();
  const plain=preview.map(part=>part.value).join('');
  const safeText=clipUtf8(plain,LIMITS.textBytes);
  return Object.freeze({html:chunks.join(''),text:safeText.value,hasMarkup,truncated:truncated || safeText.clipped});
}
module.exports={sanitizeArticleDescription,LIMITS};
