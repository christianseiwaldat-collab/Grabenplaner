// Offline Block-1 inventory. No application database, network or source writes.
// Usage: node scripts/inspect-tradefoto-catalog.mjs TRADE.accdb CASH.accdb OUTPUT.json [--replace-report]
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import Reader from 'mdb-reader';

const require = createRequire(import.meta.url);
const { TRADEFOTO_ARTICLE_ROW_FIELDS } = require('../lib/tradefoto-article-source-profile.js');
const { normalizeCrmCustomerInput } = require('../lib/crm-customers.js');
const groupDefinitions = {
  'crm.customers': ['KUNDEN'],
  'crm.customer_notes': ['Kunden_Bemerkungen'],
  'crm.customer_addresses': ['Kunden_Lieferadresse', 'KUNDEN_RLAdressen'],
  'crm.customer_documents': ['Kunden_Dokumente'],
  'crm.customer_conditions': ['Kunden_GPreisgruppen', 'Kunden_Kurznamen', 'Kunden_Preisgruppen', 'Kunden_WGR_Rabatt', 'Kunden_Zahlart', 'Kundengruppen', 'KundenKonten', 'Kundenrabattgruppen', 'ADANREDE'],
  'catalog.articles': ['ARTIKEL_STAMM'],
  'catalog.identifiers': ['ARTIKEL_ZWEITEAN'],
  'catalog.media': ['ARTIKEL_BILDER', 'ARTIKEL_BILDER_V2'],
  'catalog.notes': ['Artikel_Bemerkungen'],
  'catalog.pricing': ['ARTIKEL_GKundenPreisgruppe', 'ARTIKEL_KundenPreisgruppe', 'ARTIKEL_Kundenrabatt', 'Artikel_Preisgruppe', 'Artikel_Stamm_StaffelPreise', 'Artikel_Sortiment_Kunden_Rabattgruppen', 'Sortiment_Rabattgruppen', 'Artikel_WKZ', 'Artikel_PreisSpannen', 'Preis_Kennung', 'ARTIKEL_Provisionen'],
  'catalog.taxonomy': ['ARTIKEL_Sortimente', 'ARTIKEL_Warengruppen', 'ARTIKEL_Sparten', 'Artikel_Sortimentsart', 'Marken', 'Einheit', 'Gerätetyp', 'Batterien', 'Lagerplatz', 'Colorbild_Größe', 'Colorbild_Art', 'Eigenschaften', 'Artikel_Eigenschaften', 'SORTIMENTSZUORDNUNG', 'Pfahler_Warengruppen', 'Pfahler_Verknüpfungstabelle'],
  'catalog.bundles_accessories': ['ARTIKEL_Set', 'ARTIKEL_Zubehör', 'Artikel_Zusatz', 'Bundle', 'Bundle_Artikel', 'Hauptartikel'],
  'inventory.branch_snapshot': ['ARTIKEL_FILIALEN', 'Artikel_Ibestand'],
  'inventory.history': ['tblProtBestand', 'tblProtBestand_comp', 'tblProtPreis', 'WE_Kontrolle'],
  'inventory.legacy_aggregates': ['Artikel_Sellout', 'Lagerumschlag'],
  'suppliers.master': ['LIEFERANTEN', 'FOWIS_Lieferanten', 'Vertreter', 'Verband', 'ENTWICKLUNGSLABOR'],
  'suppliers.contacts': ['LIEFERANTEN_Adressen', 'Lieferanten_Bemerkungen'],
  'suppliers.conditions': ['LIEFERANTEN_Konditionen', 'Lieferanten_Filialen', 'ARTIKEL_ZWEITLIEFERANT'],
  'organization.source_locations': ['FILIALEN', 'Filialen_Anlage', 'Filialen_Internet'],
  'organization.source_employees': ['MITARBEITER'],
  'finance.reference_data': ['MWST_Sätze', 'MWST_Sätze_Fil', 'MWST_Sätze_Land', 'Fibu_Konten', 'Kostentraegercodes', 'Zahlungsarten', 'EinAusZahlung', 'Re_Freigabe', 'Default_Bank', 'Euro', 'EigeneKonten'],
  'sales.receipts': ['Umsatz_KASSE'],
  'sales.lines': ['Umsatz_Kasse_Details'],
  'sales.daily_report': ['Tagesbericht'],
  'finance.cash_journal': ['KassenJournal', 'KassenJournal_Details'],
  'commerce.channel_mapping': ['Shopware_Artikel', 'ARTIKEL_PlattForm', 'LAMP_Anbieter', 'LAMP_AnbieterD', 'LAMP_GeizArtikel', 'LAMP_GeizArtikelD'],
  'repairs.reference_data': ['REPARATUR_WERKSTATT', 'Reparatur_WerkstattArtikel', 'ReparaturKalkulation'],
  'legacy.documents_exports': ['Rechnung_Export', 'Rechnungsdetails_Export', 'Export_Reparatur', 'ExportRichtTabelle', 'Transfer_Alte_Umsatz_Kasse', 'Transfer_Alte_Umsatz_Kasse_Details', 'Verkauf_Artikel', 'FiL_Umsatz', 'Vertraege', 'Vertraege_Artikel'],
  'legacy.application_settings': ['ARTIKEL_Etiketten', 'Artikel_Preisschild', 'Berichtstexte', 'Defaultaktualisieren', 'DefaultMail', 'Grundeinstellungen', 'Default_Lieferanten', 'Standardwerte', 'Textbausteine', 'Feiertage', 'Feiertage-Standard', 'Stamm', 'Stamm_Artikel', 'Plugins', 'Switchboard Items'],
  'legacy.access_reference': ['Benutzer', 'Zugang', 'Zugang_Mitarbeiter', 'Mitarbeiter_Menue'],
  'legacy.technical_archive': ['dummy', 'Einfügefehler', 'TblErrorLog', 'Shopware_Protokoll_TradeDaten', 'USysApplicationLog', 'TMP_UNR', 'Protokoll'],
};
const groups = new Map(Object.entries(groupDefinitions).flatMap(([group, names]) => names.map(name => [name.toLowerCase(), group])));
const customerColumns = {
  KUND_NR: 'customer_number', NACHNAME: 'last_name', VORNAME: 'first_name', STRaße: 'street',
  PLZ: 'postal_code', ORT: 'city', Land: 'country', AdressZusatz: 'address_supplement',
  TELEFON: 'phone', EMail: 'email', UStID: 'vat_id', Geburtstag: 'birth_date',
};
const cashColumns = {
  Umsatz_KASSE: { Bonnr:'source_receipt_number', Filialid:'source_location_id', Kassenid:'register_id', Bondatum:'sale_date', Bonzeit:'sale_time', VerkäuferID:'receipt_seller_id', KUND_NR:'source_customer_number', RechnungsBetrag:'source_receipt_amount', RechnungsNr:'source_invoice_number', KontoNr:'source_account', Personalkennziffer:'legacy_personnel_code', KPLZ:'customer_postal_snapshot' },
  Umsatz_Kasse_Details: { RepID:'source_line_id', Bonnr:'source_receipt_number', Filialid:'source_location_id', Kassenid:'register_id', Bondatum:'sale_date', EAN:'source_article_key', VKMenge:'quantity', Sollpreis:'source_list_price', VK_Preis:'actual_unit_price', MWST:'source_tax_value', Rabatt_DM:'source_discount', RohertragDM:'source_margin', Verkäuferid:'line_seller_id', Artikelbezeichnung:'article_label_snapshot', UMarke:'brand_snapshot', Sortiment:'assortment_snapshot' },
};
const fieldNames = values => new Set(values.map(value => value.toLowerCase()));
const secretNames = fieldNames(['Kennwort','Passwort','Password','SMTP_Pass','Pass','Pwd','Token','ApiKey','Secret','ConnectionString','Connect']);
const mediaPattern = /^(?:a?bild|photo|foto|pfad|image|dateiname|logo|banner|reparatur_daten|ebaybildurl)$|(?:_pfad|_image)$/i;
function destination(source, table, column, system = false) {
  const group = system ? 'legacy.access_internals' : groups.get(table.toLowerCase());
  if (!group) throw new Error(`Unclassified table: ${source}.${table}`);
  const secret = secretNames.has(column.name.toLowerCase()) || /passw|kennwort|password|secret|token|smtp_pass|api.?key/i.test(column.name);
  let handling = group.startsWith('legacy.') ? 'archive_proposed' : 'model_extension_proposed';
  let target = `${group}.source_fields[${JSON.stringify(column.name)}]`;
  let note = 'Quellfeld unverändert und typisiert erhalten; Fachabbildung im zuständigen Zielbereich vor Aktivierung konkretisieren.';
  if (table === 'KUNDEN' && customerColumns[column.name]) {
    handling = 'existing_field_with_import_rules_missing';
    target = `crm_customers.${customerColumns[column.name]}`;
    note = 'Feld vorhanden; Import, Quellbindung, Konfliktregeln und Validierung fehlen. Firmenname darf nicht blind als Personenname interpretiert werden.';
  }
  if (table === 'KUNDEN' && !customerColumns[column.name]) {
    if (/^(?:INFO|KMeldungstext)$/.test(column.name)) target = `crm.customer_notes.source_fields[${JSON.stringify(column.name)}]`;
    else if (/^(?:Handy|TELEFAX|EMailRechnung|Abteilung|ANREDE)$/.test(column.name)) target = `crm.customer_contacts.source_fields[${JSON.stringify(column.name)}]`;
    else if (/bank|konto|kntnr|mandat|sepa|DateOfSignature|OffeneRech|kredit|Rechnungsgrenze|Sperr/i.test(column.name)) target = `crm.customer_finance.source_fields[${JSON.stringify(column.name)}]`;
    else if (/punkte|wincard|Kartenkunde|RabattColorbild/i.test(column.name)) target = `crm.customer_loyalty.source_fields[${JSON.stringify(column.name)}]`;
    else if (/preis|rabatt|skonto|zahlung|NettoTage|rechnung|lieferschein|Umsatz|gruppe/i.test(column.name)) target = `crm.customer_conditions.source_fields[${JSON.stringify(column.name)}]`;
  }
  if (table === 'ARTIKEL_STAMM' && TRADEFOTO_ARTICLE_ROW_FIELDS?.includes(column.name)) {
    handling = 'existing_article_import'; target = `SalesArticleCatalog.source[${JSON.stringify(column.name)}]`;
    note = 'Bestehendes Artikelprofil wiederverwenden; keine zweite Artikelidentität erzeugen.';
  }
  if (table === 'ARTIKEL_ZWEITEAN') { handling = 'existing_article_import'; note = 'Vorhandene Quellbindung/Identifier des zentralen Artikelkatalogs wiederverwenden.'; }
  if (cashColumns[table]?.[column.name]) { target = `${group}.${cashColumns[table][column.name]}`; note = 'Granulare produktive Verkaufstabellen/Quelladapter fehlen; kanonische Zuordnung als Entwurf.'; }
  if (/^(Ret|BStorno|AStorno|R|N|ZR|set|SonderartikelS|Beratung)$/.test(column.name) && source === 'cash') {
    handling = 'semantic_review'; note = 'Statuswert erhalten; Bedeutung nicht aus dem Feldnamen ableiten. Entscheidung Q02.';
  }
  if (/bank|iban|bic|blz|konto|mandat|sepa|skonto|kredit|forderung|offenerech|offeneforder|sperrgrenze/i.test(column.name)) {
    note += ' Finanz-/Konditionsdaten: getrennte berechtigte Sicht; keine Zahlung auslösen.';
  }
  if (column.name === 'Newsletter') note += ' Altkennzeichen ist kein neu erteilter Kommunikationsauftrag oder Einwilligungsnachweis.';
  if (table === 'KUNDEN' && column.name === 'Internet') note += ' Boolean, keine Website-Adresse; nicht auf crm_customers.website abbilden.';
  if (mediaPattern.test(column.name)) note += ' Medienwert oder Dateiverweis prüfen; externe Pfade/URLs nicht automatisch öffnen. Entscheidung Q08.';
  if (group === 'legacy.access_reference' || group === 'legacy.application_settings') note += ' Keine GP-Rechte, Zugänge oder laufenden Einstellungen daraus automatisch setzen.';
  if (secret) { handling = 'secret_exception'; target = 'excluded_active_import.credentials'; note = 'Nur Felddefinition inventarisiert; Geheimniswerte nicht gelesen/ausgegeben. Keine Übernahme in GP-Anmeldung. Ausnahme Q09.'; }
  if (system) { handling = 'access_internal_metadata_only'; target = 'source_manifest.access_internal_schema'; note = 'Access-interne Struktur; nur Schema/Zeilenzahl, keine Übertragung als GP-Fachtabelle.'; }
  const dataClass = secret ? 'credential_exception' : system ? 'technical_metadata' :
    /finance/.test(target) ? 'restricted_finance' : /crm\./.test(group) ? 'customer_restricted' :
      /employee|access_reference/.test(group) ? 'personnel_restricted' : 'internal_business';
  return { group, handling, target, note, dataClass, inspectValues: !secret && !system };
}
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
const id = value => String(value).toLowerCase();
function valueKey(value) {
  if (value === null || value === undefined) return null;
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : null;
  if (Buffer.isBuffer(value)) return value.toString('hex');
  const text = String(value).trim(); return text === '' ? null : text;
}
function tuple(row, columns) {
  const parts = columns.map(name => valueKey(row[name]));
  return parts.some(value => value === null) ? null : JSON.stringify(parts);
}
function metric(column, table) {
  return { inspected:0, null:0, emptyText:0, zero:0, positive:0, negative:0, true:0, false:0,
    invalid:0, maxTextLength:0, textControlCharacters:0, dateMin:null, dateMax:null, dateYears:{},
    dateRangeSuppressed:column.type === 'datetime' && (['KUNDEN','MITARBEITER'].includes(table) || /geburt|birth/i.test(column.name)),
    binaryBytes:0, references:{windows:0,unc:0,url:0,relativeOrOther:0}, type:column.type };
}
function observe(stat, column, value) {
  stat.inspected++;
  if (value === null || value === undefined) { stat.null++; return; }
  if (column.type === 'datetime') {
    if (!(value instanceof Date) || !Number.isFinite(value.getTime())) { stat.invalid++; return; }
    if (stat.dateRangeSuppressed) return;
    const date = value.toISOString();
    if (stat.dateMin === null || date < stat.dateMin) stat.dateMin = date;
    if (stat.dateMax === null || date > stat.dateMax) stat.dateMax = date;
    const year = date.slice(0,4); stat.dateYears[year] = (stat.dateYears[year] || 0) + 1; return;
  }
  if (column.type === 'boolean') { if (value === true) stat.true++; else if (value === false) stat.false++; else stat.invalid++; return; }
  if (['currency','numeric','double','float','byte','integer','long'].includes(column.type)) {
    const text = String(value);
    if (!/^[+-]?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(text) || !Number.isFinite(Number(text))) { stat.invalid++; return; }
    // Sign/count only, never monetary totals through IEEE-754.
    if (Number(text) === 0) stat.zero++; else if (text.startsWith('-')) stat.negative++; else stat.positive++; return;
  }
  if (Buffer.isBuffer(value)) { stat.binaryBytes += value.length; return; }
  const text = String(value); if (!text.trim()) stat.emptyText++;
  stat.maxTextLength = Math.max(stat.maxTextLength, text.length);
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text)) stat.textControlCharacters++;
  if (text.trim() && mediaPattern.test(column.name)) {
    const kind = /^\\\\/.test(text) ? 'unc' : /^[A-Za-z]:[\\/]/.test(text) ? 'windows' : /^https?:\/\//i.test(text) ? 'url' : 'relativeOrOther';
    stat.references[kind]++;
  }
}
function canonicalTable(source, name) { return source.tables.find(table => id(table.name) === id(name)); }
function canonicalColumns(table, names) {
  return names.map(name => { const column = table.columns.find(c => id(c.name) === id(name)); if (!column) throw new Error(`Missing field ${table.name}.${name}`); return column.name; });
}
function addKey(source, tableName, names, label) {
  const table = canonicalTable(source, tableName); if (!table) return null;
  const columns = canonicalColumns(table, names);
  const keyId = `${source.id}/${table.name}/${JSON.stringify(columns)}`;
  if (!source.keys.has(keyId)) source.keys.set(keyId, { id:keyId,table:table.name,columns,labels:[],frequencies:new Map(),nullRows:0,rows:0 });
  const entry = source.keys.get(keyId); if (label && !entry.labels.includes(label)) entry.labels.push(label);
  return keyId;
}
function relation(sources, definition) {
  const child = sources.find(s => s.id === definition.childSource), parent = sources.find(s => s.id === definition.parentSource);
  const childKey = addKey(child, definition.childTable, definition.childColumns, 'relation-child');
  const parentKey = addKey(parent, definition.parentTable, definition.parentColumns, 'relation-parent');
  return { ...definition, childKey,parentKey };
}
const [tradeFile, cashFile, outputFile, replaceOption] = process.argv.slice(2);
if (!tradeFile || !cashFile || !outputFile) throw new Error('Usage: inspect-tradefoto-catalog.mjs TRADE.accdb CASH.accdb OUTPUT.json');
const output = path.resolve(outputFile);
if (replaceOption && replaceOption !== '--replace-report') throw new Error('Unknown option.');
if (fs.existsSync(output)) {
  if (replaceOption !== '--replace-report') throw new Error('Output exists; choose a fresh analysis artifact or explicitly replace the generated report.');
  const previous = JSON.parse(fs.readFileSync(output,'utf8'));
  if (previous.format !== 'grabenplaner.tradefoto.full-inventory.v1') throw new Error('Refusing to replace an unrelated file.');
}
if ([tradeFile,cashFile].some(file => path.resolve(file).toLowerCase() === output.toLowerCase())) throw new Error('Output must not be a source file.');
const sources = [];
for (const [sourceId,file] of [['trade',tradeFile],['cash',cashFile]]) {
  const stat = fs.statSync(file); const bytes = fs.readFileSync(file); const sha256 = hash(bytes);
  // Reader mutates its in-memory buffer while decoding. Hash source bytes BEFORE construction.
  const reader = new Reader(bytes);
  const source = { id:sourceId, file, fileName:path.basename(file), bytes:stat.size, modifiedUtc:stat.mtime.toISOString(), sha256, reader,
    tables:[], systemTables:[], linkedTables:reader.getTableNames({normalTables:false,linkedTables:true}), keys:new Map() };
  for (const [system,names] of [[false,reader.getTableNames()],[true,reader.getTableNames({normalTables:false,systemTables:true})]]) {
    for (const name of names) {
      const table = reader.getTable(name);
      const entry = {name,declaredRows:table.rowCount,scannedRows:system?null:0,
        group:system?'legacy.access_internals':groups.get(id(name)), columns:table.getColumns().map(column => ({...column,
          destination:destination(sourceId,name,column,system),profile:system?null:metric(column,name)}))};
      (system?source.systemTables:source.tables).push(entry);
    }
  }
  source.relationshipRows = reader.getTable('MSysRelationships').getData({columns:['szRelationship','grbit','ccolumn','icolumn','szObject','szColumn','szReferencedObject','szReferencedColumn']});
  sources.push(source);
}
const relations = [];
for (const source of sources) {
  const grouped = new Map();
  for (const row of source.relationshipRows) {
    if (!grouped.has(row.szRelationship)) grouped.set(row.szRelationship,[]);
    grouped.get(row.szRelationship).push(row);
  }
  source.internalRelationshipCount=0;
  for (const [name,rows] of grouped) {
    rows.sort((a,b)=>a.icolumn-b.icolumn); const first=rows[0];
    if (!canonicalTable(source,first.szObject) || !canonicalTable(source,first.szReferencedObject)) { source.internalRelationshipCount++; continue; }
    relations.push(relation(sources,{evidence:'declared_in_access',name,rawFlags:first.grbit,
      childSource:source.id,childTable:first.szObject,childColumns:rows.map(r=>r.szColumn),
      parentSource:source.id,parentTable:first.szReferencedObject,parentColumns:rows.map(r=>r.szReferencedColumn)}));
  }
  for (const table of source.tables) {
    for (const column of table.columns) if (column.autoLong || column.autoUUID) addKey(source,table.name,[column.name],'autogenerated_identity_candidate');
  }
}
const cross = [
  ['cash','Umsatz_KASSE',['KUND_NR'],'trade','KUNDEN',['KUND_NR'],'customer_link',true],
  ['cash','Umsatz_KASSE',['VerkäuferID'],'trade','MITARBEITER',['Verkäufer_ID'],'receipt_seller',true],
  ['cash','Umsatz_Kasse_Details',['Verkäuferid'],'trade','MITARBEITER',['Verkäufer_ID'],'line_seller',true],
  ['cash','Umsatz_Kasse_Details',['EAN'],'trade','ARTIKEL_STAMM',['EAN'],'article_link',false],
  ['cash','Umsatz_Kasse_Details',['EAN'],'trade','ARTIKEL_ZWEITEAN',['ZweitEAN'],'alias_candidate',false],
  ['cash','Umsatz_KASSE',['Filialid'],'trade','FILIALEN',['FilialID'],'location_link',false],
  ['cash','Tagesbericht',['Filialid'],'trade','FILIALEN',['FilialID'],'historical_report_location',false],
  ['cash','KassenJournal_Details',['Filiale'],'trade','FILIALEN',['FilialID'],'historical_journal_location',false],
  ['trade','Kunden_Lieferadresse',['KUND_NR'],'trade','KUNDEN',['KUND_NR'],'alternative_address_customer_key',false],
  ['trade','KUNDEN',['KFiliale'],'trade','FILIALEN',['FilialID'],'customer_home_location',false],
  ['trade','KUNDEN',['Kundengruppe'],'trade','Kundengruppen',['Kundengruppe'],'customer_group',false],
  ['trade','tblProtPreis',['EAN'],'trade','ARTIKEL_STAMM',['EAN'],'price_history_article',false],
  ['trade','tblProtBestand',['EAN'],'trade','ARTIKEL_STAMM',['EAN'],'inventory_history_article',false],
];
for (const [childSource,childTable,childColumns,parentSource,parentTable,parentColumns,name,zeroIsUnassigned] of cross)
  relations.push(relation(sources,{evidence:'tested_candidate_not_declared',name,childSource,childTable,childColumns,parentSource,parentTable,parentColumns,zeroIsUnassigned}));
for (const [sourceId,table,columns] of [
  ['trade','KUNDEN',['KUND_NR']],['trade','ARTIKEL_STAMM',['EAN']],['trade','ARTIKEL_ZWEITEAN',['ZweitEAN']],
  ['trade','LIEFERANTEN',['Suchname']],['trade','LIEFERANTEN',['Lieferant_ID']],['trade','MITARBEITER',['Verkäufer_ID']],
  ['cash','Umsatz_KASSE',['Bonnr','Filialid','Kassenid','Bondatum']],['cash','Umsatz_Kasse_Details',['RepID']],
  ['cash','KassenJournal',['Vorgang']],['cash','KassenJournal',['Vorgang','Filiale']],
  ['cash','Tagesbericht',['ZBon','Bondatum','Filialid','Kassenid','KontoNr','Rang']],
]) addKey(sources.find(source=>source.id===sourceId),table,columns,'explicit_identity_candidate_not_pk_proof');

// Ephemeral row values stay in memory; only aggregate diagnostics enter the report.
const quality = {};
const receiptSellers = new Map(), historyIds = new Map();
const receiptColumns = ['Bonnr','Filialid','Kassenid','Bondatum'];
function inspectQuality(source, table, rows) {
  if (table.name === 'KUNDEN') {
    const template = {customerNumber:'',customerType:'private',companyName:'',firstName:'Schema probe',lastName:'',street:'',addressSupplement:'',postalCode:'',city:'',country:'',phone:'',email:'',website:'',vatId:'',birthDate:null,customFields:[]};
    const failures = {}, emails = new Map();
    let noName = 0, withoutFirstName = 0, zeroCustomerNumber = 0;
    for (const row of rows) {
      if (!String(row.VORNAME || '').trim() && !String(row.NACHNAME || '').trim()) noName++;
      if (!String(row.VORNAME || '').trim()) withoutFirstName++;
      if (row.KUND_NR === 0) zeroCustomerNumber++;
      const email = String(row.EMail || '').trim().toLowerCase();
      if (email) emails.set(email,(emails.get(email)||0)+1);
      for (const [sourceField,snakeTarget] of Object.entries(customerColumns)) {
        const field = snakeTarget.replace(/_([a-z])/g,(_,letter)=>letter.toUpperCase());
        let value = row[sourceField];
        if (value instanceof Date) value = Number.isFinite(value.getTime()) ? value.toISOString().slice(0,10) : 'invalid-date';
        else if (sourceField === 'KUND_NR' && value !== null) value = String(value);
        try { normalizeCrmCustomerInput({...template,[field]:value}); }
        catch (error) {
          if (!error.code?.startsWith('CRM_')) throw error;
          // Missing customer names are assessed across both real name fields above.
          if (error.code !== 'CRM_NAME_REQUIRED') failures[sourceField]=(failures[sourceField]||0)+1;
        }
      }
    }
    quality.crm = {rows:rows.length,noName,withoutFirstName,zeroCustomerNumber,fieldSyntaxFailures:failures,
      duplicatedNonEmptyEmailGroups:[...emails.values()].filter(n=>n>1).length,
      duplicateEmailRowsBeyondFirst:[...emails.values()].reduce((sum,n)=>sum+Math.max(0,n-1),0),
      method:'Pure current CRM validator per mapped field with synthetic other fields. No customer creation. Customer type is a syntax-test placeholder, not inferred business classification. Shared email is not evidence for merging people.'};
  }
  if (table.name === 'Kunden_Lieferadresse') quality.deliveryAddress = {rows:rows.length,
    zeroNamedCustomerNumber:rows.filter(row=>row.KUND_NR === 0).length,
    differentKidAndNamedCustomerNumber:rows.filter(row=>row.KID !== row.KUND_NR).length};
  if (table.name === 'ARTIKEL_BILDER_V2') {
    const extensions = {}, references = new Set();
    for (const row of rows) {
      const ref = String(row.Bild || '').trim(); if (ref) references.add(ref);
      const extension = /\.([a-z0-9]{1,5})$/i.exec(ref)?.[1]?.toLowerCase() || 'other';
      extensions[extension]=(extensions[extension]||0)+1;
    }
    quality.articleMedia = {referenceRows:rows.length,distinctReferences:references.size,extensions,
      embeddedBinaryColumns:table.columns.filter(column=>['binary','ole'].includes(column.type)).length,
      availability:'Not checked: external directories and URLs were not opened.'};
  }
  if (['tblProtBestand','tblProtBestand_comp'].includes(table.name)) {
    const ownIds = new Map();
    for (const row of rows) {
      const key = valueKey(row.ID);
      const payload = JSON.stringify([valueKey(row.Aenderung),row.FilialID,row.EAN,row.Bestand,row.AlterBestand]);
      ownIds.set(key,payload);
    }
    historyIds.set(table.name,ownIds);
  }
  if (source.id === 'cash' && table.name === 'Umsatz_KASSE') {
    for (const row of rows) receiptSellers.set(tuple(row,receiptColumns),valueKey(row['VerkäuferID']));
  }
  if (source.id === 'cash' && table.name === 'Umsatz_Kasse_Details') {
    const check = {rows:rows.length,matchingNonZero:0,bothZero:0,differentNonZero:0,lineZeroHeaderNonZero:0,lineNonZeroHeaderZero:0,missingHeader:0,missingSellerValue:0,fractionalQuantity:0};
    for (const row of rows) {
      const key = tuple(row,receiptColumns), line = valueKey(row['Verkäuferid']), header = receiptSellers.get(key);
      if (!receiptSellers.has(key)) check.missingHeader++;
      else if (line === null || header === null) check.missingSellerValue++;
      else if (line === '0' && header === '0') check.bothZero++;
      else if (line === '0') check.lineZeroHeaderNonZero++;
      else if (header === '0') check.lineNonZeroHeaderZero++;
      else if (line === header) check.matchingNonZero++;
      else check.differentNonZero++;
      if (Number.isFinite(row.VKMenge) && !Number.isInteger(row.VKMenge)) check.fractionalQuantity++;
    }
    quality.sellerAttribution = check;
  }
}
for (const source of sources) {
  for (const table of source.tables) {
    const projected = table.columns.filter(column=>column.destination.inspectValues);
    const keys=[...source.keys.values()].filter(key=>key.table===table.name);
    const original=source.reader.getTable(table.name);
    // A complete table read avoids deriving coverage from stale Access row counts
    // or from physical row offsets across deleted records.
    const rows=original.getData({columns:projected.map(column=>column.name)});
    table.scannedRows=rows.length;
    inspectQuality(source,table,rows);
    for (const row of rows) {
      for (const column of projected) observe(column.profile,column,row[column.name]);
      for (const key of keys) { key.rows++;const value=tuple(row,key.columns); if(value===null)key.nullRows++;else key.frequencies.set(value,(key.frequencies.get(value)||0)+1); }
    }
    for (const column of table.columns) if(!column.destination.inspectValues) column.profile=null;
    table.metadataRowDifference=table.declaredRows-table.scannedRows;
    process.stderr.write(`${source.id}.${table.name}: ${table.scannedRows} rows, ${table.columns.length} columns\n`);
  }
}
const recentHistory = historyIds.get('tblProtBestand'), compactHistory = historyIds.get('tblProtBestand_comp');
quality.inventoryHistoryOverlap = {sharedIds:0,sharedIdsDifferentPayload:0};
for (const [key,payload] of recentHistory) if (compactHistory.has(key)) {
  quality.inventoryHistoryOverlap.sharedIds++;
  if (compactHistory.get(key)!==payload) quality.inventoryHistoryOverlap.sharedIdsDifferentPayload++;
}
function summarizeKey(key) {
  return {id:key.id,table:key.table,columns:key.columns,labels:key.labels,rows:key.rows,nullRows:key.nullRows,distinctNonNull:key.frequencies.size,
    duplicateRows:[...key.frequencies.values()].reduce((sum,count)=>sum+Math.max(0,count-1),0)};
}
for(const relation of relations) {
  const child=sources.find(source=>source.id===relation.childSource).keys.get(relation.childKey);
  const parent=sources.find(source=>source.id===relation.parentSource).keys.get(relation.parentKey);
  let matchedRows=0,orphanRows=0,orphanKeys=0,unassignedZeroRows=0,ambiguousRows=0;
  const usedParents=new Set();
  for(const [key,count] of child.frequencies) {
    if(relation.zeroIsUnassigned && key==='["0"]'){unassignedZeroRows+=count;continue;}
    const matches=parent.frequencies.get(key)||0;
    if(matches){matchedRows+=count;usedParents.add(key);if(matches>1)ambiguousRows+=count;} else{orphanRows+=count;orphanKeys++;}
  }
  relation.check={childRows:child.rows,nullChildRows:child.nullRows,unassignedZeroRows,matchedRows,ambiguousRows,orphanRows,orphanKeys,
    parentRows:parent.rows,parentDistinct:parent.frequencies.size,unreferencedParentKeys:parent.frequencies.size-usedParents.size};
}
const report={format:'grabenplaner.tradefoto.full-inventory.v1',createdAt:new Date().toISOString(),scope:'Block 1/6: source inventory and target proposal only',
  method:{reader:'mdb-reader 3.2.0',textKeyComparison:'exact trimmed text; Access collation not inferred',money:'sign and presence counts only; currency decoded as decimal strings; no turnover totals',indexes:'Reader exposes no indexes. Candidate uniqueness and Access relationships are NOT a primary-key/index declaration.',privacy:'No row samples, names, addresses, customer numbers, seller numbers, passwords, free texts, raw paths, binary contents or personal date ranges in output.',dates:'Access civil date/time is represented by the reader as Date with Z; this is not evidence of a source UTC time zone. Customer/personnel date ranges suppressed.',systemData:'System schemas and row counts only; MSysRelationships metadata read explicitly.',externalData:'Linked tables and external file references recorded without resolving paths or fetching URLs.'},
  sources:sources.map(source=>({id:source.id,fileName:source.fileName,bytes:source.bytes,modifiedUtc:source.modifiedUtc,sha256:source.sha256,
    tables:source.tables,systemTables:source.systemTables,linkedTables:source.linkedTables,accessRelationshipRows:source.relationshipRows.length,
    internalRelationshipCount:source.internalRelationshipCount,keys:[...source.keys.values()].map(summarizeKey)})),relations,quality};
for(const source of sources) {
  const verified=hash(fs.readFileSync(source.file));
  if(verified!==source.sha256)throw new Error(`Source changed during analysis: ${source.fileName}`);
}
report.sourceHashesVerifiedAfterRead=true;
report.coverage={tables:report.sources.reduce((sum,s)=>sum+s.tables.length,0),fields:report.sources.reduce((sum,s)=>sum+s.tables.reduce((n,t)=>n+t.columns.length,0),0),
  rowsScanned:report.sources.reduce((sum,s)=>sum+s.tables.reduce((n,t)=>n+t.scannedRows,0),0),
  unclassifiedFields:report.sources.flatMap(source=>source.tables.flatMap(table=>table.columns)).filter(column=>!column.destination.target || !column.destination.handling).length};
for (const source of report.sources) source.schemaSha256=hash(JSON.stringify(source.tables.map(table=>({name:table.name,columns:table.columns.map(({destination,profile,...schema})=>schema)}))));
fs.mkdirSync(path.dirname(output),{recursive:true});
fs.writeFileSync(output,JSON.stringify(report,null,2)+'\n',{flag:replaceOption === '--replace-report'?'w':'wx'});
process.stdout.write(JSON.stringify({output,coverage:report.coverage,sourceHashesVerifiedAfterRead:true})+'\n');
