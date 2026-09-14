'use strict';
const vatRates=new Map([['0',0],['1',20],['2',10],['3',19],['4',7]]);
const decimal=value=>typeof value==='string'&&/^-?\d+(?:\.\d+)?$/.test(value)&&Number.isFinite(Number(value))?value:null;
function usablePrice(article,type,basis){
  const values=(article.prices||[]).filter(p=>p.priceType===type&&p.priceBasis===basis&&p.currency==='EUR'
    &&['confirmed','inferred'].includes(p.qualityStatus)&&decimal(p.amount)!==null);
  return values.length===1?values[0].amount:null;
}
function catalogVat(article){
  // The old, already accepted article import retains exact gross/net pairs.
  // Use only an unambiguous supported rate; never assume 20% for all articles.
  let possible=[...vatRates.values()],pairs=0;
  for(const type of ['sales','internet_1','internet_2','internet_3','internet_4','internet_5']){
    const gross=usablePrice(article,type,'gross'),net=usablePrice(article,type,'net');
    if(gross===null||net===null||Number(net)<=0||Number(gross)<=0)continue;
    pairs++;
    possible=possible.filter(rate=>Math.abs(Number(gross)-Number(net)*(1+rate/100))<=0.01000001);
  }
  return pairs&&possible.length===1?possible[0]:null;
}
function articleCalculation(article,source=null){
  const trade=article.sourceSystem==='tradefoto.artikel_stamm';
  let purchaseNet=null,vatPercent=null,vatSource=null;
  if(trade&&source){
    purchaseNet=decimal(source.DurchschnittEK);vatPercent=vatRates.get(String(source.MWST))??null;vatSource='master';
  }else if(trade){
    // Confirmed by the business: this exact TradeFoto field is average NET EK.
    // Older accepted snapshots still label it unknown/unresolved. EuroEk,
    // NNPreis, DEK_A and quarantined values are deliberately not substitutes.
    const prices=(article.prices||[]).filter(p=>p.sourceField==='DurchschnittEK'&&p.priceType==='average_purchase'&&p.currency==='EUR');
    if(prices.length===1){const p=prices[0];if(p.priceBasis==='unknown'&&p.qualityStatus==='unresolved'
      ||p.priceBasis==='net'&&['confirmed','inferred'].includes(p.qualityStatus))purchaseNet=decimal(p.amount);}
    vatPercent=catalogVat(article);vatSource='price_pairs';
  }else purchaseNet=usablePrice(article,'average_purchase','net');
  const hasCost=purchaseNet!==null&&Number(purchaseNet)>=0,hasVat=vatPercent!==null;
  return {purchaseNet,vatPercent,vatSource,basis:'Durchschnitts-EK netto',available:hasCost&&hasVat,
    unavailableReason:hasCost&&hasVat?null:!hasCost&&!hasVat?'Durchschnitts-EK netto und MwSt. nicht verfügbar.'
      :!hasCost?'Durchschnitts-EK netto nicht verfügbar.':'MwSt. nicht eindeutig verfügbar.'};
}
module.exports={articleCalculation,usablePrice,decimal};
