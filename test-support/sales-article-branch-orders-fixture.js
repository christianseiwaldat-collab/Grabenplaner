'use strict';
const { seedWorkspace } = require('./sales-article-workspace-fixture');
async function seedBranchOrders({ access, source }) {
  const { article } = await seedWorkspace({ access, source });
  const heads = [{ BestellNr:'101', LFilialID:18, erledigt:false, Suchname:'PRIVATE CUSTOMER', Text1:'PRIVATE MEMO' },
    { BestellNr:'106', LFilialID:19, erledigt:false }];
  const details = [
    { BestellId:'10101', BestellNr:101, EAN:'005479', BMenge:'9', gMenge:'2', Verteiler:true, Artikeltext:'PRIVATE LINE' },
    { BestellId:'10102', BestellNr:101, EAN:'005479', BMenge:'3', gMenge:'2', Verteiler:true },
    { BestellId:'10601', BestellNr:106, EAN:'005479', BMenge:'2', gMenge:'0', Verteiler:false },
  ];
  const distributions = [
    { BestellNr:'101', BestellId:10101, FilialID:'18', EAN:'005479', Menge:'4', GelMenge:'0' },
    { BestellNr:'101', BestellId:10101, FilialID:'19', EAN:'005479', Menge:'5', GelMenge:'2' },
    { BestellNr:'101', BestellId:10102, FilialID:'19', EAN:'005479', Menge:'3', GelMenge:'2' },
  ];
  await source.ingest('BESTELLUNGEN', heads);
  await source.ingest('BESTELLDETAILS', details);
  await source.ingest('BestellVerteilung', distributions);
  await source.ingest('ARTIKEL_FILIALEN', [
    { EAN:'005479', FilialID:'18', FBestand:3, Bestellt:4 },
    { EAN:'005479', FilialID:'19', FBestand:0, Bestellt:6 },
  ], { sourceInstance:'tradefoto-trade', snapshotAt:'2026-09-17T09:00:00.000Z' });
  return { article, heads, details, distributions };
}
module.exports = { seedBranchOrders };
