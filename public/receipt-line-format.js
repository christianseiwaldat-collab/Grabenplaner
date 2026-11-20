(function attach(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.GrabenplanerReceiptLineFormat = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function receiptLineFormat() {
  'use strict';
  function decimal(value) {
    const match = typeof value === 'string' || typeof value === 'number'
      ? String(value).match(/^(-?)(\d{1,24})(?:\.(\d{1,24}))?$/) : null;
    return match ? { integer: BigInt(match[1] + match[2] + (match[3] || '')), scale: (match[3] || '').length } : null;
  }
  // Display the signed source position amount independently of its contribution
  // to sales. Round once after multiplication, using exact decimal arithmetic.
  function total(price, quantity) {
    const a = decimal(price), b = decimal(quantity);
    if (!a || !b) return null;
    const product = a.integer * b.integer * 100n, divisor = 10n ** BigInt(a.scale + b.scale);
    const absolute = product < 0n ? -product : product;
    const cents = absolute / divisor + (absolute % divisor * 2n >= divisor ? 1n : 0n);
    return (product < 0n && cents ? '-' : '') + (cents / 100n) + '.' + String(cents % 100n).padStart(2, '0');
  }
  const money = value => total(value, '1')?.replace('.', ',') ?? '–';
  function groups(item) {
    if (!Object.hasOwn(item, 'personnel')) return [{ personnel: null, lines: item.lines || [] }];
    const groups = new Map();
    for (const line of item.lines || []) {
      const personnel = String(line.personnel ?? '').trim();
      if (!groups.has(personnel)) groups.set(personnel, { personnel, lines: [] });
      groups.get(personnel).lines.push(line);
    }
    return [...groups.values()];
  }
  const note = status => ({ return: 'Rückgabe', adjustment: 'Rabatt / Gegenbuchung', payment: 'Zahlungsmittel · kein Warenumsatz',
    deposit: 'Anzahlung / Verrechnung · ohne Rohertrag',
    voucher_issue: 'Gutscheinausgabe · kein Warenumsatz',
    uid_clearing: 'UID-Zwischenbuchung · kein Warenumsatz',
    excluded: 'Ausgeschlossen', review: 'Prüfung offen' }[status] || '');
  function taxText(line){return line.net==null||line.tax==null?'':[
    line.vatRate==null?'':`USt ${line.vatRate} %`,`Netto ${money(line.net)}`,`Steuer ${money(line.tax)}`].filter(Boolean).join(' · ');}
  function reconciliationText(row){
    const value=row.reconciliation;if(!value)return '';
    const basis={gross:'Bruttobetrag',net:'Nettobetrag'}[value.headerBasis]||'ungeklärte Betragsbasis';
    if(value.headerStatus==='unavailable_zero_placeholder')return 'Quellbetrag 0,00 ist ein bestätigter Platzhalter; kein Nachweis einer kostenlosen Abgabe oder Zahlung.';
    return `Belegabgleich auf ${basis}${value.difference==null?' · Differenz nicht ermittelt':' · Differenz '+money(value.difference)}${row.gross==null?' · Prüfung offen':''}`;
  }
  const escape = text => String(text).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  function deviceHistory(line, tradeHistory = false) {
    const serial = String(line.deviceNumber ?? '').trim(), article = String(line.article ?? '').trim();
    if (!serial) return '';
    const label = 'Erfasste Gerätenummer: ' + escape(serial);
    const cash = serial.length <= 80 && article && article !== '0' && article.length <= 150;
    const trade = tradeHistory && serial.length <= 150;
    if (!cash && !trade) return '<small>' + label + '</small>';
    const attributes = ' data-device-serial="' + escape(serial) + '" data-device-article="' + escape(article) + '"';
    return '<details class="receipt-device-history"><summary>' + label + '</summary>' +
      (cash ? '<button type="button" class="secondary-button" data-device-history="cash"' + attributes + '>Kassenbelege zum Gerät</button>' : '') +
      (trade ? '<button type="button" class="secondary-button" data-device-history="trade"' + attributes + '>Gerätehistorie im Einkauf</button>' : '') +
      '</details>';
  }
  return Object.freeze({ total, money, groups, note,taxText,reconciliationText,deviceHistory });
}));
