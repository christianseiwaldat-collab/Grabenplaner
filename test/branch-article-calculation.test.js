'use strict';
const test = require('node:test'), assert = require('node:assert/strict');
const Calc = require('../public/branch-article-calculation'), UI = require('../public/portal-branch-sales');
const { businessStatus, productLinks, usablePrice } = require('../lib/branch-article-detail');
const basis = { available: true, purchaseNet: '100', vatPercent: 20 };
const {articleCalculation}=require('../lib/branch-article-basis');
const legacyArticle=()=>({sourceSystem:'tradefoto.artikel_stamm',prices:[
  {priceType:'average_purchase',sourceField:'DurchschnittEK',amount:'955.306884385816',currency:'EUR',priceBasis:'unknown',qualityStatus:'unresolved'},
  {priceType:'average_purchase',sourceField:'EuroEk',amount:'0',currency:'EUR',priceBasis:'unknown',qualityStatus:'unresolved'},
  ...[['gross','1329'],['net','1107.5']].map(([priceBasis,amount])=>({priceType:'sales',amount,priceBasis,currency:'EUR',qualityStatus:'inferred'}))]});
test('already accepted legacy article prices supply the confirmed average EK before the separate master takeover',()=>{
  const article=legacyArticle(),calculation=articleCalculation(article);
  assert.equal(calculation.available,true);assert.equal(calculation.purchaseNet,'955.306884385816');assert.equal(calculation.vatPercent,20);
  assert.equal(Calc.margin('1329',calculation).amount.toFixed(2),'152.19');
  assert.equal(Calc.sellingPrice(10,calculation).gross,1273.75);
  const html=UI.articleBody({stocks:[],description:'Synthetic legacy article',retailGross:'1329',internetGross:'1289',calculation});
  assert.doesNotMatch(html,/data-calc="percent"[^>]*disabled|RE nicht verfügbar/);assert.match(html,/aus Brutto-\/Nettopreisen/);
});
test('ambiguous prices and quarantine do not enable RE; an applied master remains authoritative',()=>{
  for(const change of [a=>a.prices.push({...a.prices[0]}),a=>a.prices[0].qualityStatus='quarantined',a=>a.prices[0].sourceField='NNPreis',a=>a.prices[3].amount='1000']){
    const a=legacyArticle();change(a);assert.equal(articleCalculation(a).available,false);
  }
  assert.equal(articleCalculation(legacyArticle(),{DurchschnittEK:'100',MWST:2}).vatPercent,10);
  assert.equal(articleCalculation(legacyArticle(),{DurchschnittEK:null,MWST:1}).available,false);
  assert.equal(articleCalculation(legacyArticle(),{DurchschnittEK:'100',MWST:99}).available,false);
  for(const rate of [0,10,19,20]){const a=legacyArticle();a.prices[2].amount=String(100*(1+rate/100));a.prices[3].amount='100';assert.equal(articleCalculation(a).vatPercent,rate);}
  const small=legacyArticle();small.prices[2].amount='0.01';small.prices[3].amount='0.01';assert.equal(articleCalculation(small).available,false);
});
test('RE uses net proceeds, supports loss and a 3 percent target without a percentage markup', () => {
  assert.deepEqual(Calc.margin('150', basis), { gross: 150, net: 125, amount: 25, percent: 20 });
  assert.deepEqual(Calc.margin('96', basis), { gross: 96, net: 80, amount: -20, percent: -25 });
  const target = Calc.sellingPrice('3', basis); assert.equal(target.gross, 123.72); assert.ok(target.percent >= 3 && target.percent < 3.01);
  assert.equal(Calc.sellingPrice('-25', basis).gross, 96); assert.equal(Calc.sellingPrice(0, basis).gross, 120);
  assert.equal(Calc.margin(110, { ...basis, vatPercent: 10 }).amount.toFixed(8), '0.00000000');
  assert.equal(Calc.margin(100, { ...basis, vatPercent: 0 }).amount, 0);
});
test('Zero, missing values and impossible targets stay distinct', () => {
  assert.equal(Calc.margin(0, basis).amount, -100); assert.equal(Calc.margin(0, basis).percent, null);
  assert.equal(Calc.margin(100, { ...basis, purchaseNet: '0' }).percent, 100);
  for (const value of [null, '', undefined, true, 'NaN', 'Infinity', -1]) assert.equal(Calc.margin(value, basis), null);
  for (const value of [100, 101, -10001, null, '']) assert.equal(Calc.sellingPrice(value, basis), null);
  for (const value of [{ ...basis, purchaseNet: null }, { ...basis, vatPercent: null }, { ...basis, available: false }]) assert.equal(Calc.margin(120, value), null);
  assert.equal(Calc.sellingPrice(3, { ...basis, purchaseNet: '0' }), null);
});
test('German price entry and six digit article presentation preserve source identity', () => {
  for (const [input, expected] of [['1.234,56', 1234.56], ['1.234', 1234], ['-3,5', -3.5], ['3.5', 3.5], ['0', 0], ['  12,50  ', 12.5]]) assert.equal(Calc.input(input), expected);
  for (const input of ['', '--2', '1,2,3', '3%', 'Infinity', '1e2', '<script>']) assert.equal(Calc.input(input), null);
  assert.equal(UI.articleNumber('42'), '000042'); assert.equal(UI.articleNumber('000042'), '000042');
  assert.equal(UI.articleNumber('1234567'), '1234567'); assert.equal(UI.articleNumber('A42'), 'A42');
});
test('Status is source driven, links are optional and cost quality gates are retained', () => {
  for (const value of ['Stamm', 'keine LW', 'EOL', 'Sonderstatus']) assert.equal(businessStatus({ Sortimentsart: value }), value);
  assert.equal(businessStatus({ Sortimentsart: 'Abverkauf', Abverkauf: true }), 'Abverkauf');
  assert.equal(businessStatus({ Auslaufartikel: true }), 'Auslauf');
  assert.deepEqual(productLinks('javascript:alert(1) file:///secret https://u:p@example.com'), []);
  assert.equal(productLinks('Produkt#https://geizhals.at/produkt#')[0].kind, 'geizhals');
  const price = { priceType: 'average_purchase', priceBasis: 'net', currency: 'EUR', amount: '100', qualityStatus: 'confirmed' };
  assert.equal(usablePrice({ prices: [price] }, 'average_purchase', 'net'), '100');
  for (const extra of [{ qualityStatus: 'quarantined' }, { priceBasis: 'unknown' }, { currency: 'USD' }]) assert.equal(usablePrice({ prices: [{ ...price, ...extra }] }, 'average_purchase', 'net'), null);
  assert.equal(usablePrice({ prices: [price, price] }, 'average_purchase', 'net'), null);
});
test('Article body renders negative RE, safe media, links and independent accessible calculators', () => {
  const html = UI.articleBody({ description: '<script>x</script>', status: '<b>Stamm</b>', ownLocationId: '00', stocks: [{ id: '00', own: true, quantity: '0' }, { id: '18', quantity: '-2' }],
    retailGross: '96', internetGross: '150', calculation: basis, links: [{ label: 'bad', href: 'javascript:alert(1)' }, { label: 'Produkt', href: 'https://example.com/' }], imageUrl: 'https://evil.test/tracking' });
  assert.match(html, /-25,00/); assert.match(html, /-20,00 € netto/); assert.match(html, /branch-negative/);
  assert.match(html, /<strong class="branch-negative">96,00 €/);
  assert.match(html, /data-calc="gross"/); assert.match(html, /data-calc="percent"/); assert.match(html, /aria-live="polite"/);
  assert.match(html, /Filiale 00/); assert.match(html, /Filiale 18/); assert.match(html, /&lt;b&gt;Stamm/);
  assert.doesNotMatch(html, /javascript:|evil\.test|<script>/);
});
test('Additive stock read compiles against the PostgreSQL Sales schema', () => {
  const { BRANCH_ARTICLE_CATALOG } = require('../lib/persistence/postgresql/reporting/branch-article-catalog');
  const entry = BRANCH_ARTICLE_CATALOG[0]; assert.equal(entry.statement.operation, 'queryAll');
  assert.match(entry.sql, /integration\."import_history_records"/); assert.match(entry.sql, /LIMIT/);
  assert.equal(entry.parameterOrder.length, 6);
  assert.equal(require('../lib/persistence/postgresql/sales/catalog').createSalesCatalog(8).entries.length, 219);
});
