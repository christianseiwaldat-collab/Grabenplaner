'use strict';
const C=require('./data-import-contract');
// A deliberately small business projection, never a raw-source response. Even
// malformed values remain text; unrelated customer, personnel and memo fields
// are not disclosed by this view.
const ARTICLE_FIELDS=['EAN','Artikelbezeichnung','Verkaufspreis','Filialbestand','Auslaufartikel','Änderungsdatum'];
const ROW_FIELDS=['EAN','ZweitEAN','Rang','FilialID','FBestand','Artikelnummer','Rechnungsnummer','RechnungsNr','ReparaturNr','InventurNr','Belegnummer'];
const value=input=>input===null||input===undefined?null:['string','number','boolean'].includes(typeof input)?String(input).slice(0,500):'[Ungültiger Werttyp]';
function invalidFields(profile,source){
  const issues=[];
  for(const field of profile.fields){
    let code=null;
    if(!Object.hasOwn(source,field.source))code='IMPORT_FIELD_MISSING';
    else try{
      const normalized=C.normalizeDataImportValue(source[field.source],field);
      if(profile.keyFields.includes(field.source)&&(normalized===null||typeof normalized==='string'&&!normalized.trim()))code='IMPORT_KEY_MISSING';
    }catch(error){if(!(error instanceof C.DataImportError))throw error;code=error.code;}
    if(code)issues.push({field:field.source,code,value:ROW_FIELDS.includes(field.source)||ARTICLE_FIELDS.includes(field.source)?value(source[field.source]):null});
  }
  return issues;
}
function articleContext(source,{rowNumber=null,state=null,status='same_file'}={}){
  const fields=Object.fromEntries(ARTICLE_FIELDS.map(key=>[key,value(source[key])]));
  const ean=fields.EAN;
  return {status,rowNumber,state,articleNumber:/^\d{13}$/.test(ean||'')?BigInt(ean).toString().padStart(6,'0'):null,...fields};
}
function projectIssue(profile,row,source){
  const table=profile.sourceTable;
  return {rowNumber:row.rowNumber,state:row.state,issue:row.issue,table,
    fields:Object.fromEntries(ROW_FIELDS.filter(key=>Object.hasOwn(source,key)).map(key=>[key,value(source[key])])),
    invalidFields:row.state==='invalid'?invalidFields(profile,source):[],
    impact:table==='ARTIKEL_ZWEITEAN'?'optional_identifier':table==='ARTIKEL_FILIALEN'?'stock_snapshot':table==='ARTIKEL_STAMM'?'article':'row',
    article:table==='ARTIKEL_STAMM'?articleContext(source,{rowNumber:row.rowNumber,state:row.state}):null};
}
module.exports={projectIssue,articleContext};
