'use strict';
const crypto=require('node:crypto');
const Model=require('./sales-article-report-model');
const {projectionFor}=require('./tradefoto-bestell/access');
const {canonical}=require('./data-import-contract');
const {actorFor,specValue,LIMITS}=require('./sales-article-report-store');
const TTL=15*60*1000,MAX_BYTES=64*1024*1024,MAX_ENTRIES=32,MAX_PER_ACTOR=2;
const signature=session=>canonical({actor:actorFor(session),capabilities:Model.capabilities(session),scope:projectionFor(session)});
function createArticleReportPreviews({now=Date.now}={}){
 const entries=new Map();let bytes=0;
 function remove(token){const entry=entries.get(token);if(entry){clearTimeout(entry.timer);bytes-=entry.snapshot.pdf.buffer.length;entries.delete(token);}}
 function prune(){for(const [token,entry] of entries)if(entry.expires<=now())remove(token);}
 function unavailable(){Model.fail('Die PDF-Vorschau ist abgelaufen. Bitte die Vorschau neu erstellen.',410,'ARTICLE_REPORT_PREVIEW_EXPIRED');}
 return Object.freeze({
  put(session,spec,report,pdf){
   prune();if(!Buffer.isBuffer(pdf.buffer)||pdf.buffer.length>LIMITS.pdfBytes)Model.fail('Die PDF-Auswertung ist zu groß.',413,'ARTICLE_REPORT_STORAGE_LIMIT');
   const actor=actorFor(session).key,owned=[...entries].filter(([,entry])=>entry.actor===actor);
   while(owned.length>=MAX_PER_ACTOR)remove(owned.shift()[0]);
   while(entries.size>=MAX_ENTRIES||bytes+pdf.buffer.length>MAX_BYTES)remove(entries.keys().next().value);
   const token=crypto.randomBytes(32).toString('hex'),entry={actor,signature:signature(session),expires:now()+TTL,
    snapshot:{id:crypto.randomUUID(),spec:specValue(spec),sourceAt:report.sourceAt,locationIds:[...new Set(report.rows.map(row=>row.locationId))].sort(),pdf:{...pdf,buffer:Buffer.from(pdf.buffer)}},pending:null,saved:null};
   entry.timer=setTimeout(()=>remove(token),TTL);entry.timer.unref?.();entries.set(token,entry);bytes+=pdf.buffer.length;return token;
  },
  get(session,token){
   prune();if(typeof token!=='string'||!/^[a-f0-9]{64}$/.test(token))unavailable();
   const entry=entries.get(token);if(!entry||entry.actor!==actorFor(session).key)unavailable();
   if(entry.signature!==signature(session))Model.fail('Die Freigaben wurden geändert. Bitte die PDF-Vorschau neu erstellen.',403,'ARTICLE_REPORT_FORBIDDEN');
   return entry;
  },
  removeReport(session,id){const actor=actorFor(session).key;for(const [token,entry] of entries)if(entry.actor===actor&&entry.snapshot.id===id)remove(token);},
  dispose(){for(const token of entries.keys())remove(token);},
 });
}
module.exports={createArticleReportPreviews,TTL,MAX_BYTES,MAX_ENTRIES,MAX_PER_ACTOR};
