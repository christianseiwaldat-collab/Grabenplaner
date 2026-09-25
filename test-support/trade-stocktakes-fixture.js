'use strict';
const C=require('../lib/data-import-contract');
async function seedStocktakes(f,{branches=['18','19'],snapshotAt='2026-09-14T09:00:00.000Z',quantity='-2',suffix=''}={}){
 const heads=[{InventurNummer:'101',InventurFilialid:branches[0],InventurDatum:'2026-09-10T00:00:00.000',gebucht:true,Positionszahl:120,PositiveDifferenzen:1,NegativeDifferenzen:1,OhneDifferenz:117,UnvollstaendigeMengen:1},
 {InventurNummer:'101',InventurFilialid:branches[1],InventurDatum:'2026-09-11T00:00:00.000',gebucht:true,Positionszahl:70,PositiveDifferenzen:0,NegativeDifferenzen:0,OhneDifferenz:70,UnvollstaendigeMengen:0}];
 const detail=(ID,EAN,extra={})=>({ID:String(ID),Inventurnummer:'101',InventurFilialid:branches[0],EAN,AlteMenge:'5',NeueMenge:'3',Differenz:quantity,NNPreis:'149.99',...extra});
 const details=[detail(1,'000042'),detail(2,'OLD-42',{NeueMenge:'6.25',Differenz:'1.25'}),detail(3,'000042',{AlteMenge:null,NeueMenge:null,Differenz:null}),detail(4,'000042',{NeueMenge:'6',Differenz:'0'})];
 const options={sourceInstance:'tradefoto-inventur',snapshotAt,fileSha256:C.fingerprint([heads,details,suffix])};
 const headRun=await f.ingest('Inventur',heads,options),detailRun=await f.ingest('Inventurdetails',details,options);
 return {heads,details,options,headRun,detailRun};
}
module.exports={seedStocktakes};
