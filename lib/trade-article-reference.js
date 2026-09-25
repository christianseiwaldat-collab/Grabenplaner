'use strict';
// Display-only interpretation. Never produces a GP target, price or stock value.
function resolveArticleReference(key,candidates,{businessDate=null}={}) {
 const day=businessDate?String(businessDate).slice(0,10):null;
 const validDay=v=>/^\d{4}-\d{2}-\d{2}$/.test(v||'')&&!Number.isNaN(Date.parse(v+'T00:00:00Z'))&&new Date(v+'T00:00:00Z').toISOString().slice(0,10)===v;
 const rows=candidates.filter(c=>c.articleNumber===key).map(c=>({...c}));
 let eligible=rows,status='missing',selected=null;
 if(day){
  if(!validDay(day))return {articleNumber:key,status:'period_unknown',label:null,candidates:rows,businessDate:day};
  eligible=rows.filter(c=>{
   const from=c.createdAt?.slice(0,10),to=c.deletedAt?.slice(0,10);
   if(from&&!validDay(from)||to&&!validDay(to)||from&&to&&from>to)return true;
   return (!from||day>=from)&&(!to||day<=to);
  });
 }
 if(eligible.length>1)status='ambiguous';
 else if(eligible.length===1){
  selected=eligible[0];const from=selected.createdAt?.slice(0,10),to=selected.deletedAt?.slice(0,10);
  status=day&&(!validDay(from)||(selected.origin==='archive'&&!validDay(to))||to&&!validDay(to)||from&&to&&from>to)?'period_unknown':selected.origin==='archive'?'archived':'current';
 }else if(rows.length)status='outside_period';
 return {articleNumber:key,status,label:['current','archived'].includes(status)?selected.label:null,candidates:rows,businessDate:day};
}
module.exports={resolveArticleReference};
