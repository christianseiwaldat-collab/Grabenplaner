'use strict';
// Local, read-only qualification model. No import, application DB or mail writes.
const D=require('../../../lib/tradefoto-bestell/decimal');
const text=v=>v==null?'':String(v);
const key=v=>text(v).toLocaleLowerCase('de-AT');
const pair=(number,supplier)=>JSON.stringify([key(number),key(supplier)]);
function decimal(value){
  if(value==null||value==='')return null;
  if(!Number.isFinite(Number(value)))throw Error('Invalid source quantity or price');
  const s=String(value);if(!/e/i.test(s))return s;
  const [base,exponent]=s.toLowerCase().split('e'),sign=base.startsWith('-')?'-':'',parts=base.replace('-','').split('.'),digits=parts.join(''),point=parts[0].length+Number(exponent);
  return sign+(point<=0?'0.'+'0'.repeat(-point)+digits:point>=digits.length?digits+'0'.repeat(point-digits.length):digits.slice(0,point)+'.'+digits.slice(point));
}
const day=v=>v instanceof Date?v.toISOString().slice(0,10):v?String(v).slice(0,10):null;
function createModel({heads,details,masters}){
  const invoices=new Map(),articles=new Map(),byArticle=new Map();
  for(const h of heads){const k=pair(h.Rechnungsnr,h.Suchname);if(invoices.has(k))throw Error('Ambiguous supplier invoice');invoices.set(k,h);}
  for(const a of masters){const k=key(a.EAN);if(articles.has(k))throw Error('Ambiguous article');articles.set(k,{number:text(a.EAN),label:text(a.Artikelbezeichnung),current:true,saleGross:decimal(a.Verkaufspreis),averageNet:decimal(a.DurchschnittEK)});}
  let missingCurrent=0,negativePositions=0;
  for(const d of details){
    const h=invoices.get(pair(d.Rechnungsnr,d.Suchname));if(!h)throw Error('Invoice position without matching supplier and invoice number');
    const a=key(d.EAN);if(!a)throw Error('Invoice position without article number');
    if(!articles.has(a))articles.set(a,{number:text(d.EAN),label:text(d.Artikelbezeichnung)||'Bezeichnung nicht hinterlegt',current:false,saleGross:null,averageNet:null});
    if(!articles.get(a).current)missingCurrent++;
    let groups=byArticle.get(a);if(!groups){groups=new Map();byArticle.set(a,groups);}
    const k=pair(d.Rechnungsnr,d.Suchname);let row=groups.get(k);
    if(!row){row={id:text(h.ID),number:text(h.Rechnungsnr),supplier:text(h.BFirma)||text(h.Suchname),supplierCode:text(h.Suchname),created:day(h.Anlegedatum),booked:day(h.Buchdatum),quantity:'0',quantityMissing:false,negative:false,positions:[]};groups.set(k,row);}
    const quantity=decimal(d.menge),price=decimal(d.Rechnungspreis);
    if(quantity===null)row.quantityMissing=true;else row.quantity=D.add(row.quantity,quantity);
    if(quantity!==null&&D.compare(quantity,'0')<0){row.negative=true;negativePositions++;}
    row.positions.push({id:text(d.ID),movement:text(d.we_id),quantity,price,netNet:decimal(d.NNPreis),delivery:text(d.WELieferscheinnr),location:text(d.Filialid)});
  }
  for(const groups of byArticle.values())for(const r of groups.values()){
    const prices=[...new Set(r.positions.map(p=>p.price).filter(p=>p!==null))].sort(D.compare);
    r.priceMin=prices[0]??null;r.priceMax=prices.at(-1)??null;r.mixedPrice=prices.length>1;r.priceMissing=r.positions.some(p=>p.price===null);
    if(r.quantityMissing)r.quantity=null;
  }
  const candidates=[...articles.values()].map(a=>({...a,invoiceCount:byArticle.get(key(a.number))?.size||0}));
  const normalize=v=>key(v).normalize('NFKD').replace(/\p{M}/gu,'');
  function search(query){
    if(typeof query!=='string'||query.length>150)throw Error('Invalid search');
    const q=normalize(query.trim()),terms=q.split(/\s+/);if(!q)return [];
    return candidates.filter(a=>{const s=normalize(a.number+' '+a.label);return terms.every(t=>s.includes(t));})
      .sort((a,b)=>(key(b.number)===key(query.trim()))-(key(a.number)===key(query.trim()))||Number(b.number.startsWith(query))-Number(a.number.startsWith(query))||b.invoiceCount-a.invoiceCount||a.number.localeCompare(b.number,'de-AT'))
      .slice(0,30);
  }
  function article(number){const a=articles.get(key(number));if(!a)return null;return {article:a,rows:[...(byArticle.get(key(number))?.values()||[])]};}
  return {search,article,summary:{headers:heads.length,positions:details.length,articlesWithInvoices:byArticle.size,positionsWithoutCurrentArticle:missingCurrent,negativePositions}};
}
module.exports={createModel,decimal,pair};
