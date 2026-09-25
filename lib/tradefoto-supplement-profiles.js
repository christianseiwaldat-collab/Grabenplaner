'use strict';
const C=require('./data-import-contract');
const physical=C.freeze(require('./tradefoto-supplement-schema.json'));
const selections={
  weum:{
    WE:['We_ID','We','Umlagerung','EAN','Suchname','FilialID','Filialid2','Menge','WEDatum','AkWeDatum','Bestellnr','Lieferscheinnr','Rechnungsnr','KorbId','NNPreis','Rechnungspreis'],
    'ARTIKEL_STAMMGelöscht':['EAN','Artikelbezeichnung','Suchname','Sortiment','MWST','Anlagedatum','Löschdatum'],
  },
  inventur:{
    Inventur:['InventurNummer','InventurFilialid','InventurDatum','gebucht','Positionszahl','PositiveDifferenzen','NegativeDifferenzen','OhneDifferenz','UnvollstaendigeMengen'],
    Inventurdetails:['ID','Inventurnummer','InventurFilialid','EAN','AlteMenge','Differenz','NeueMenge','NNPreis'],
  },
};
const profiles=new Map();
const tables=Object.entries(selections).flatMap(([kind,selected])=>Object.entries(selected).map(([name,fields])=>{
  const schema=physical[kind].tables.find(t=>t.name===name);
  const columns=fields.map(field=>({...schema.columns.find(c=>c.name===field),name:field,
    type:schema.columns.find(c=>c.name===field)?.type||'long',dataClass:['NNPreis','Rechnungspreis'].includes(field)?'catalog_costs':'internal_business'}));
  const entity='trade-supplement.'+C.fingerprint([kind,name]).slice(0,20);
  const table={name,columns,keys:schema.keys,source:'trade',sourceFile:kind,sourceSystem:'tradefoto.'+kind,
    schemaSha256:C.fingerprint({schema,selection:fields,version:1}),group:kind==='weum'?'inventory.movements':'inventory.counts'};
  const identifiers=new Set([...schema.keys,'EAN','Suchname','FilialID','Filialid2','Inventurnummer','InventurFilialid','MWST','Sortiment']);
  const mapped=columns.map((c,i)=>({source:c.name,target:'f'+i,nullable:true,
    type:identifiers.has(c.name)?'identifier':['text','memo'].includes(c.type)?'source_text':c.type==='datetime'?'civil_datetime':
      ['long','byte','integer'].includes(c.type)?'integer':['double','float'].includes(c.type)?'source_decimal':c.type==='currency'?'decimal':c.type,
    ...(c.type==='currency'?{scale:12}:{})}));
  profiles.set(name,C.defineDataImportProfile({id:entity,entity,version:1,sourceSystem:table.sourceSystem,
    sourceTable:name,schemaSha256:table.schemaSha256,keyFields:table.keys,fields:mapped,dataClasses:[...new Set(columns.map(c=>c.dataClass))]}));
  return table;
}));
module.exports={physical,tables:C.freeze(tables),profileFor:name=>profiles.get(name)};
