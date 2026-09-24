'use strict';
const C=require('./data-import-contract');
const {projectionFor}=require('./tradefoto-bestell/access');
function registerTradeInsightJobRoutes(app,{jobs,requireSession,refreshSession,assertCsrf}){
 const route=(work,pdf=false)=>async(req,res)=>{
  res.set({'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff'});
  try{
   const original=requireSession(req,'sales:history:read');if(req.method!=='GET')assertCsrf(req);
   const fresh=async()=>{const session=await refreshSession(req);if(!session||session.employeeNumber!==original.employeeNumber||session.accountId!==original.accountId||!projectionFor(session).read||session.mustChangePassword)C.fail('IMPORT_FORBIDDEN',403);return session;};
   const session=await fresh(),signature=C.canonical(projectionFor(session)),result=await work(session,req);
   if(signature!==C.canonical(projectionFor(await fresh())))C.fail('IMPORT_FORBIDDEN',403);
   if(pdf){res.set({'Content-Type':'application/pdf','Content-Disposition':'attachment; filename="Einkauf-Bestand-Ergebnis.pdf"','Content-Security-Policy':"default-src 'none'; sandbox allow-downloads"});res.send(result);}else res.json(result);
  }catch(error){const status=error.status>=400&&error.status<=599?error.status:500;res.status(status).json({code:status===500?'IMPORT_REPORT_FAILED':error.code,error:status===403?'Die Berechtigung für diesen Ergebnisstand fehlt oder wurde geändert.':status===404?'Dieser Ergebnisstand ist nicht mehr vorhanden.':status===409?'Der Auftrag ist noch nicht fertig, wurde geändert oder die Ablage ist voll (höchstens 50 Ergebnisse, 3 laufende Suchen).':status===413?'Die Ergebnismenge ist zu groß. Bitte die Auswahl eingrenzen.':status===503?'Die Datenquelle ist noch nicht verfügbar.':'Der Ergebnisstand konnte nicht verarbeitet werden.'});}
 };
 const base='/api/trade-insights/jobs';
 app.get(base,route(session=>jobs.list(session)));
 app.post(base,route((session,req)=>jobs.create(session,req.body)));
 app.get(base+'/:id/pdf',route(async(session,req)=>require('./trade-insight-pdf').createTradeInsightPdf(await jobs.get(session,req.params.id),{sort:req.query.sort||'',direction:req.query.direction||'asc'}),true));
 app.get(base+'/:id',route((session,req)=>jobs.get(session,req.params.id)));
 app.post(base+'/:id/rename',route((session,req)=>jobs.rename(session,req.params.id,req.body)));
 app.post(base+'/:id/cancel',route((session,req)=>jobs.cancel(session,req.params.id)));
 app.post(base+'/:id/remove',route((session,req)=>jobs.remove(session,req.params.id)));
}
module.exports={registerTradeInsightJobRoutes};
