'use strict';

// Observed business activity, not birthdays, expiry dates, promised delivery
// dates or Access's 1899 time-only values. Keep this independent of upload time.
const FIELDS = Object.freeze({
  WE:['WEDatum','AkWeDatum'], 'ARTIKEL_STAMMGelöscht':['Anlagedatum','Löschdatum'], Inventur:['InventurDatum'],
  Artikel_Bemerkungen: ['Datum'], Bundle: ['Änderungsdatum'], Bundle_Artikel: ['Änderungsdatum'],
  KUNDEN: ['Anlagedatum', 'Änderungsdatum'], Kunden_Bemerkungen: ['Datum'],
  LIEFERANTEN: ['Weaktualisiert'], Lieferanten_Bemerkungen: ['Datum'], Marken: ['Änderungsdatum'],
  ARTIKEL_STAMM: ['Änderungsdatum', 'Anlagedatum', 'SW_Änderungsdatum'],
  KUNDEN_RLAdressen: ['Anlegedatum'], ARTIKEL_FILIALEN: ['inventurdat', 'Bestandsänderungsdatum'],
  Export_Reparatur: ['Anlegedatum', 'KVDatum', 'ReklamationDatum', 'RepAuftragDatum', 'AbgeholtDatum', 'Bezahlt_Datum', 'AbholNachrichtDatum'],
  FiL_Umsatz: ['LDatum'], Rechnung_Export: ['Anlegedatum'], Rechnungsdetails_Export: ['Lieferscheindatum'],
  tblProtBestand: ['Aenderung'], tblProtBestand_comp: ['Aenderung'], tblProtPreis: ['Aenderung'],
  Transfer_Alte_Umsatz_Kasse: ['Bondatum'], Transfer_Alte_Umsatz_Kasse_Details: ['Bondatum'],
  Verkauf_Artikel: ['vkdatum'], WE_Kontrolle: ['WEDatum'],
  KassenJournal: ['Datum'], Umsatz_KASSE: ['Bondatum'], KassenJournal_Details: ['Datum'],
  Tagesbericht: ['Bondatum'], Umsatz_Kasse_Details: ['Bondatum'],
  ANGEBOTE: ['AngebotDatum'], Auftrag: ['Anlegedatum', 'IBestelldatum'],
  BESTELLKORB: ['KDatum', 'ErledigtDatum', 'Anforderungdatum', 'Lieferscheindruck'],
  BESTELLUNGEN: ['Bestelldatum', 'Zahldatum'], Lieferscheine: ['Bondatum', 'IBestelldatum'],
  Lieferscheinerstellung: ['Datum', 'IBestelldatum'], Ratenzahlungen: ['Zahldatum'],
  Rechnung_Z: ['Anlegedatum', 'Zahldatum', 'Erstellungsdatum', 'Mahndatum1', 'Mahndatum2', 'Mahndatum3', 'Versanddatum', 'IBestelldatum'],
  Rechnungsdetails_Z: ['Lieferscheindatum', 'BooklieferscheinDatum'],
  Reklamation: ['Anlegedatum', 'Nachfrage1', 'Nachfrage2', 'Nachfrage3', 'InfoAm1', 'InfoAm2', 'InfoAm3'],
  Reparatur: ['Anlegedatum', 'KVDatum', 'ReklamationDatum', 'RepAuftragDatum', 'AbgeholtDatum', 'Bezahlt_Datum', 'Abholnachrichtdatum'],
  Studio: ['Anlegedatum'], Teilzahlungen: ['Zahlungsdatum', 'Gebucht'],
  Vertraege_verkauft: ['Datum', 'AktivierungsDatum', 'GutschriftDatum'],
});
const VERSION = 1;
function fieldsFor(profile) {
  return (FIELDS[profile.sourceTable] || []).filter(name => profile.fields.some(f => f.source === name && f.type === 'civil_datetime'));
}
function civil(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?$/.test(value)) return null;
  const normalized = value.slice(0,19) + '.' + (value.split('.')[1] || '').padEnd(3,'0');
  const date = new Date(normalized + 'Z');
  if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0,-1) !== normalized || normalized < '1900-01-01') return null;
  return normalized;
}
function empty() { return { version: VERSION, status: 'pending', value: null, evidence: null }; }
function accumulate(result, profile, rows, uploadedAt) {
  const fields = fieldsFor(profile);
  // Civil Access values have no timezone. Permit the next UTC date to cover
  // exports from positive offsets; never treat a far-future entry as freshness.
  const upperDay = new Date(Date.parse(uploadedAt) + 86400000).toISOString().slice(0,10);
  for (const row of rows) for (const field of fields) {
    const value = civil(row?.[field]);
    if (value && value.slice(0,10) <= upperDay && (!result.value || value > result.value)) {
      result.value = value;
      result.evidence = { table: profile.sourceTable, field };
    }
  }
  return result;
}
function merge(result, part) {
  if (part.value && (!result.value || part.value > result.value)) { result.value=part.value; result.evidence=part.evidence; }
  return result;
}
module.exports = { VERSION, FIELDS, fieldsFor, civil, empty, accumulate, merge };
