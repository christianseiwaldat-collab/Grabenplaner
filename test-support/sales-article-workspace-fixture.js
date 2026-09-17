'use strict';
const { createSalesArticleCatalogRepository } = require('../lib/persistence/repositories/sales-article-catalog');
const { salesArticleImportContentSha256 } = require('../lib/sales-article-catalog');
const { fingerprint } = require('../lib/data-import-contract');
async function seedWorkspace({access,source}) {
  const price = (sourceField,priceType,amount,priceBasis='unknown',qualityStatus='unresolved') => ({sourceField,priceType,amount,currency:'EUR',priceBasis,qualityStatus});
  const prices = [
    price('UPE','upe','279','gross','inferred'),price('Verkaufspreis','sales','229','gross','inferred'),
    price('eNvk','sales','190.833333333333','net','inferred'),price('Internet_VK','internet_1','219','gross','inferred'),
    price('Invk','internet_1','182.5','net','inferred'),price('DurchschnittEK','average_purchase','170'),
    price('Listeneckpreis','list_purchase','211.25'),price('Rechnungspreis','invoice_purchase','211.25'),
    price('NNPreis','net_net_purchase','191.6'),price('SonderPreis','special','201.18'),
    price('ListeneckpreisZu','future_purchase','215'),price('DEK_A','dek_a','169'),
  ];
  const articles = [
    {sourceArticleKey:'005479',articleNumber:'005479',description:'HAMA 5120 ÜBERGEWINDE 1/4" ZU 3/8" EINZELN',active:true,sourceUpdatedAt:null,
      identifiers:[{identifierType:'ean13',identifierValue:'4007249051202',isPrimary:true,sourceField:'ZweitEAN',sourceRank:1},
        {identifierType:'ean13',identifierValue:'4006381333931',isPrimary:false,sourceField:'ZweitEAN',sourceRank:2}],prices},
    {sourceArticleKey:'005480',articleNumber:'005480',description:'HAMA 5120 Zubehör – Beispiel',active:true,sourceUpdatedAt:null,identifiers:[],prices:[]},
  ];
  await createSalesArticleCatalogRepository(access).importSnapshot({snapshot:{
    sourceSystem:'tradefoto.artikel_stamm',sourceProfileVersion:'workspace-test-v1',sourceSchemaSha256:fingerprint('workspace-schema'),
    sourceFileSha256:fingerprint(articles),contentSha256:salesArticleImportContentSha256(articles),snapshotAt:'2026-09-16T10:00:00.000Z',articles},
    actor:'synthetic-owner',timestamp:'2026-09-16T10:00:00.000Z'});
  await source.ingest('LIEFERANTEN',[{Suchname:'Ham',Firma:'Hama GmbH · Beispiel-Lieferant'}],{master:true});
  await source.ingest('ARTIKEL_Sortimente',[{Sortiment:'40302',Bezeichnung:'Sonstiges Stativ-Zubehör'}],{master:true});
  const master = {EAN:'005479',Artikelbezeichnung:articles[0].description,Suchname:'Ham',Bestellnummer:'H-5120',Sortiment:'40302',
    Marke:'Hama',Sortimentsart:'Stamm',MWST:1,DurchschnittEK:'170',AKurzbeschreibung:'Adapter für Stativgewinde',ALieferumfang:'Ein Übergewinde',
    HerstellerLink:'https://example.com/produkt https://geizhals.at/beispiel-a123.html https://www.idealo.de/preisvergleich/beispiel.html',
    LVKDatum:'2026-09-16T00:00:00.000',LVKAe:68,S_Out:'0'};
  await source.ingest('ARTIKEL_STAMM',[master,{EAN:'005480',Artikelbezeichnung:articles[1].description,Bestellnummer:'H-5120',MWST:2}],{master:true});
  await source.ingest('ARTIKEL_ZWEITLIEFERANT',[{EAN:'005479',ZSuchname:'Ham',ZBestellnummer:'L-98765'}],{master:true});
  await source.ingest('ARTIKEL_FILIALEN',[{EAN:'005479',FilialID:'18',FBestand:3},{EAN:'005479',FilialID:'19',FBestand:0}],
    {sourceInstance:'tradefoto-trade'});
  return {master,article:await createSalesArticleCatalogRepository(access).getByArticleNumber('005479')};
}
module.exports = {seedWorkspace};
