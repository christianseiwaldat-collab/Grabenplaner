'use strict';
const C=require('../data-import-contract');
const {buildSalesHistoryProjection}=require('../sales-history-access');
const {buildSalesAnalyticsProjection}=require('../sales-analytics-access');
// Personal, separately assignable capabilities. Developer full access is
// resolved by the central permission catalog, never by client input.
const BESTELL_PERMISSIONS=Object.freeze({PURCHASING:'sales:purchasing:read',REPAIRS:'sales:repairs:read',CLASSIFY:'sales:inventory:classify',REPAIR_WRITE:'sales:repairs:write'});
function projectionFor(session){const history=buildSalesHistoryProjection(session),sales=buildSalesAnalyticsProjection(session),p=new Set(session?.permissions||[]);
  return C.freeze({read:history.read,company:history.company,locationIds:history.locationIds,unassigned:history.unassigned,inventory:history.read&&sales.inventory,online:sales.onlineShop,
    customers:history.customerPurchases,finance:history.finance,costs:history.read&&sales.grossMargin,
    classify:history.read&&sales.inventory&&history.company&&p.has(BESTELL_PERMISSIONS.CLASSIFY),repairWrite:history.customerPurchases&&p.has(BESTELL_PERMISSIONS.REPAIRS)&&p.has(BESTELL_PERMISSIONS.REPAIR_WRITE),
    purchasing:history.read&&sales.inventory&&p.has(BESTELL_PERMISSIONS.PURCHASING),repairs:history.customerPurchases&&p.has(BESTELL_PERMISSIONS.REPAIRS)});}
function canReadLocation(sourceKey,projection,resolveLocation){const mapped=resolveLocation(sourceKey);
  if(!mapped||mapped.state!=='linked')return projection.company&&projection.unassigned;
  return projection.company||projection.locationIds.includes(mapped.locationId);}
function visibleSourceFields(table,row,projection,metadata){if(!projection.read)C.fail('IMPORT_FORBIDDEN',403);const def=metadata.tables.find(t=>t.name===table&&t.included);if(!def)C.fail('IMPORT_BESTELL_TABLE_EXCLUDED');const result={};
  for(const c of def.columns){const allowed=c.dataClass==='internal_business'||c.dataClass==='catalog_costs'&&projection.costs||
      c.dataClass==='restricted_finance'&&projection.finance||c.dataClass==='customer_restricted'&&projection.customers;
    // Personnel fields are not needed for these prepared views. A later seller
    // view must use the existing separate seller permission and source binding.
    if(allowed)result[c.name]=row[c.name];}
  return result;}
const BESTELL_PERMISSION_CATALOG=Object.freeze([
 [BESTELL_PERMISSIONS.PURCHASING,'Einkauf und Filialversorgung lesen','Bestellmengen, kumulierte Lieferstände und Filialanforderungen in freigegebenen Filialen; benötigt Bestands- und Historienrechte.'],
 [BESTELL_PERMISSIONS.REPAIRS,'Reparaturen lesen','Reparatur- und Gerätehistorie in freigegebenen Filialen; benötigt kundenbezogene Historienrechte.'],
 [BESTELL_PERMISSIONS.CLASSIFY,'Physische Artikelklassifikation pflegen','Firmenweite Warengruppen-/Sortimentsvorgaben und Artikel-Ausnahmen für Bestandskennzahlen bearbeiten.'],
 [BESTELL_PERMISSIONS.REPAIR_WRITE,'Eigene GP-Reparaturstatus pflegen','Abholbereit und abgeholt im GP setzen; Quellstände bleiben erhalten.'],
].map(([id,label,description])=>Object.freeze({id,label,description,group:'Verkaufsverwaltung',warningLevel:'high',scopeBehavior:'organizational',eligibleRoles:['manager','admin','developer']})));
module.exports={BESTELL_PERMISSIONS,BESTELL_PERMISSION_CATALOG,projectionFor,canReadLocation,visibleSourceFields};
