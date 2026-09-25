'use strict';
const C=require('./data-import-contract');
function registerTradeInsightRoutes(app,{runtime,dispatchRead,requireSession,refreshSession,assertCsrf}){
 const route=kind=>async(req,res)=>{
  res.set('Cache-Control','private, no-store');
  try{
   requireSession(req,'sales:history:read');if(req.method!=='GET')assertCsrf(req);
   let session=await refreshSession(req);const identity=JSON.stringify([session?.id,session?.employeeNumber,session?.permissions,session?.scopes]);
   const fresh=async executor=>{const current=await refreshSession(req,executor);if(!current||identity!==JSON.stringify([current.id,current.employeeNumber,current.permissions,current.scopes]))C.fail('IMPORT_FORBIDDEN',403);return current;};
   const query=req.method==='GET'?{}:req.body;
   const result=dispatchRead&&!kind.endsWith('-save')?await dispatchRead({operation:'trade-insights',kind,query,session:{employeeNumber:session?.employeeNumber}}):await runtime.run(fresh,kind,query);
   await fresh();res.json(result);
  }catch(e){const code=/^IMPORT_[A-Z_]+$/.test(e?.code||'')?e.code:'IMPORT_OPERATION_FAILED';
   const status=[400,401,403,404,409,413,422,429,503].includes(e.status)?e.status:500;
   const message=status===403?'Für diese Ansicht fehlt die Freigabe.':code==='IMPORT_BESTELL_CURSOR'?'Der Datenstand oder die Auswahl hat sich geändert. Bitte neu suchen.':code==='IMPORT_BESTELL_SOURCE_INCOMPLETE'?'Ein verwendeter Import ist noch nicht vollständig übernommen. Bitte den Import abschließen.':status===503?'Die Auswertung ist gerade ausgelastet. Bitte kurz warten.':status<500?'Bitte Auswahl und Suchangaben prüfen.':'Die Daten konnten nicht geladen werden.';
   res.status(status).json({code,error:message});
  }
 };
 app.get('/api/trade-insights/context',route('context'));
 for(const kind of ['suggestions','stocktakes','movements','purchasing','transfers','inventory','stock-summary','prices','stock-metadata','stock-summary-metadata','classification','classification-save','repairs','repair-detail','repair-save','customer-history','device-history','article-history'])app.post('/api/trade-insights/'+kind,route(kind));
}
module.exports={registerTradeInsightRoutes};
