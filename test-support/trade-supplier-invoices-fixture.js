'use strict';
const C=require('../lib/data-import-contract');
async function seedSupplierInvoices(f,{suffix='',snapshotAt='2026-09-13T09:00:00.000Z',detailsOverride=null}={}){
 const heads=[
  {ID:1,Rechnungsnr:'RE-001',Suchname:'Demo',BFirma:'Demo Optik GmbH',Anlegedatum:'2026-09-10T00:00:00.000',Buchdatum:'2026-09-08T00:00:00.000'},
  {ID:2,Rechnungsnr:'RE-001',Suchname:'Zwei',BFirma:'Zweiter Lieferant',Anlegedatum:'2026-09-11T00:00:00.000',Buchdatum:null},
  {ID:3,Rechnungsnr:'RE-003',Suchname:'Demo',BFirma:'Demo Optik GmbH',Anlegedatum:'2025-12-15T00:00:00.000',Buchdatum:'2025-12-14T00:00:00.000'},
 ];
 const line=(id,extra={})=>({ID:String(id),we_id:String(100+id),Rechnungsnr:'RE-001',Suchname:'demo',EAN:'000042',Artikelbezeichnung:'Demo Fernglas',menge:'0.1',Rechnungspreis:'247.06',NNPreis:'229.76',Filialid:0,WELieferscheinnr:'LS-42',...extra});
 const details=detailsOverride||[line(11),line(12,{menge:'0.2',Rechnungspreis:'248.10'}),line(13,{Suchname:'Zwei',menge:'-1'}),line(14,{Rechnungsnr:'RE-003',EAN:'OLD-0042',menge:null,Rechnungspreis:null})];
 const options={sourceInstance:'tradefoto-lieferantenrechnungen',snapshotAt,fileSha256:C.fingerprint([heads,details,suffix])};
 const headRun=await f.ingest('Rechnung_A',heads,options),lineRun=await f.ingest('Rechnungsdetails_A',details,options);
 return {heads,details,options,headRun,lineRun};
}
async function seedInvoiceArticleCatalog(access){
 const articles=[{sourceArticleKey:'000042',articleNumber:'000042',description:'Demo Fernglas',active:true,sourceUpdatedAt:null,identifiers:[],prices:[]}];
 await require('../lib/persistence/repositories/sales-article-catalog').createSalesArticleCatalogRepository(access).importSnapshot({snapshot:{sourceSystem:'tradefoto.artikel_stamm',sourceProfileVersion:'supplier-invoice-test-v1',sourceSchemaSha256:C.fingerprint('invoice-fixture'),sourceFileSha256:C.fingerprint(articles),contentSha256:require('../lib/sales-article-catalog').salesArticleImportContentSha256(articles),snapshotAt:'2026-09-13T09:00:00.000Z',articles},actor:'synthetic-owner',timestamp:'2026-09-13T09:00:00.000Z'});
}
module.exports={seedSupplierInvoices,seedInvoiceArticleCatalog};
