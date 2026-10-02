'use strict';
const C = require('./data-import-contract');
const { SALES_HISTORY_PERMISSIONS: P } = require('./sales-history-access');
const { capabilities } = require('./sales-article-sales-model');
function registerSalesArticleSalesRoutes(app,{runtime,requireSession,refreshSession,assertCsrf}) {
  app.post('/api/sales/articles/history/sales',async(request,response) => {
    response.set({'Cache-Control':'private, no-store',Pragma:'no-cache','X-Content-Type-Options':'nosniff'});
    try {
      const session = requireSession(request,P.READ),initial = capabilities(session); if (!initial.sales) C.fail('IMPORT_FORBIDDEN',403); assertCsrf(request);
      const getSession = async() => { const fresh = await refreshSession(request); if (!fresh || fresh.employeeNumber !== session.employeeNumber || fresh.accountId !== session.accountId) C.fail('IMPORT_FORBIDDEN',403); return fresh; };
      const result = await runtime.run(getSession,workspace => {
        if (!workspace?.articleSales) return {available:false,rows:[],next:null,complete:true,total:0,durationMs:0,capabilities:capabilities(session),note:'Noch kein Kassenstand übernommen.'};
        return workspace.articleSales.search(request.body);
      });
      if (C.canonical(capabilities(await getSession())) !== C.canonical(initial)) C.fail('IMPORT_FORBIDDEN',403);
      response.json(result);
    } catch(error) {
      const code = /^(IMPORT_|PORTAL_)[A-Z0-9_]+$/.test(error?.code || '') ? error.code : 'IMPORT_OPERATION_FAILED';
      const messages = { IMPORT_HISTORY_DATE_RANGE:'Bitte einen gültigen Zeitraum bis heute wählen.',IMPORT_HISTORY_RESULTS_CHANGED:'Datenstand oder Berechtigung geändert. Bitte erneut suchen.',
        IMPORT_ARTICLE_SALES_QUERY:'Die Artikelsuche oder Sortierung ist ungültig.',IMPORT_ARTICLE_SALES_LIMIT:'Bitte den Zeitraum verkleinern: höchstens 10.000 Verkaufspositionen pro Suche.',
        IMPORT_RECEIPT_SEARCH_BUSY:'Eine umfangreiche Suche läuft bereits. Bitte kurz warten.' };
      response.status(error.status >= 400 && error.status < 600 ? error.status : 500).json({code,error:messages[code] || (error.status === 403 ? 'Für diese Artikelverkäufe fehlt die persönliche Berechtigung.' : 'Die Artikelverkäufe konnten nicht sicher gelesen werden.')});
    }
  });
}
module.exports = { registerSalesArticleSalesRoutes };
