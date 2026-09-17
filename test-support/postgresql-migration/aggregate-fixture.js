'use strict';
const {trustTradeFotoReportPages}=require('../../lib/sales-analytics-tradefoto-report');
// Synthetic parser input in PDF coordinates. No customer or historical document.
function aggregatePreview({month=7}={}){
  if(![7,8].includes(month))throw new Error('Synthetic month must have 31 days');
  const mm=String(month).padStart(2,'0');
  const items=[],height=595.28;
  const add=(text,x,top,width=20)=>items.push({text,x,y:height-top,width});
  add('Warengruppenvergleich netto Filiale: 18',29,18,300);
  add('*GsJahr ab: 01.01.26',29,35,100);
  add('Menge Umsatz Rohertrag KundenAnzahl Umsatz/Kunde',160,35,500);
  add(`01.${mm}.26-`,140,67);add(`01.${mm}.25-`,186,67);
  add(`31.${mm}.26`,140,78);add(`31.${mm}.25`,186,78);
  add('101',29.3,104);add('Synthetische Kameras',54.4,104,90);
  const group=[178.3,226.9,350.8,406.1,519.6,568.3,676.9,720,766.2,808.6];
  const total=[186.6,234.1,356.9,414.1,525.7,574.6,678.6,723.5,767.8,811.2];
  const period=['2','1','100,00','80,00','25,00','20,00','2,00','1,00','50,00','80,00'];
  const year=['10','8','500,00','400,00','125,00','100,00','8,00','7,00','62,50','57,14'];
  for(const [top,edges,values] of [[104,group,period],[126.55,group,year],[150.4,total,period],[172.95,total,year]]){
    values.forEach((value,i)=>add(value,edges[i]-20,top));
  }
  add('Seite: 1 von 1',29,555);add(month===7?'03.08.26':'03.09.26',760,555);
  return trustTradeFotoReportPages([{number:1,height,width:841.89,items}],{contentSha256:(month===7?'b':'c').repeat(64),byteLength:1000,fileName:'synthetisch.pdf'});
}
module.exports={aggregatePreview};
