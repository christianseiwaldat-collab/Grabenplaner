'use strict';

// Product selection from the reviewed Trade analysis. Availability describes
// implemented readers, never permission to accept an arbitrary Access file.
const SOURCE_CATALOG = Object.freeze([
  {kind:'trade',fileName:'Trade_Daten.accdb',purpose:'Artikel, Filialbestände und Stammdaten',group:'recommended',available:true},
  {kind:'cash',fileName:'Kassen_Umsätze.accdb',purpose:'Kassenbelege und Verkaufspositionen',group:'recommended',available:true},
  {kind:'bestell',fileName:'Trade_DatenBestell.accdb',purpose:'Bestellungen, Rechnungen und Reparaturen',group:'recommended',available:true},
  {kind:'weum',fileName:'WEUM.accdb',purpose:'Wareneingänge, Umlagerungen und historische Artikel',group:'recommended',available:true},
  {kind:'inventur',fileName:'InventurProtokoll.accdb',purpose:'Inventurübersicht, Differenzen und Prüffälle',group:'recommended',available:true},
  {kind:'lieferantenrechnungen',fileName:'TRADE_AusgangsRech.accdb',purpose:'Optional für Lieferantenrechnungen und Zahlungen',group:'optional',available:false},
  {kind:'rio',fileName:'RIO.accdb',purpose:'Optional für Ringfoto-Aktionen und Meldungen',group:'optional',available:false},
  {kind:'kundenbestellungen',fileName:'Kundenbestellungen.accdb',purpose:'Zusätzliche Kundenbestellhistorie',group:'optional',available:false},
  {kind:'protokoll',fileName:'Protokoll.accdb',purpose:'Preis- und Stammdatenänderungen',group:'optional',available:false},
  {kind:'internet',fileName:'internet.accdb',purpose:'Webartikel und Produkttexte',group:'optional',available:false},
  {kind:'shopware',fileName:'Shopware.accdb',purpose:'Shopbestellungen; lange Textfelder benötigen eine erneut geprüfte Quelle',group:'optional',available:false},
  {kind:'belieferung',fileName:'Belieferung.accdb',purpose:'Leere Vorgangstabelle und bereits vorhandene Barcode-Zuordnung',group:'local',available:false},
  {kind:'gutscheine',fileName:'Gutscheine.accdb',purpose:'Druckvorlagen und wenige historische Einzelcodes',group:'local',available:false},
  {kind:'email',fileName:'TRADE_EMAIL_DATEN.accdb',purpose:'Historisches E-Mail-Archiv',group:'local',available:false},
  {kind:'fehler',fileName:'FehlerProtokoll.accdb',purpose:'Fehlerprotokoll des alten Trade-Programms',group:'local',available:false},
].map(Object.freeze));
const SOURCE_KINDS=Object.freeze(SOURCE_CATALOG.filter(source=>source.available).map(source=>source.kind));
module.exports={SOURCE_CATALOG,SOURCE_KINDS};
