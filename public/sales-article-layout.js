(function(root, factory) {
  const value = factory();
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.SalesArticleLayout = value;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  function link(href, label) {
    try {
      const url = new URL(href);
      if (['http:','https:'].includes(url.protocol) && !url.username && !url.password)
        return '<a href="' + esc(url.href) + '" target="_blank" rel="noopener noreferrer" referrerpolicy="no-referrer">' + esc(label) + '</a>';
    } catch {}
    return esc(label);
  }
  function fieldValue(field) {
    if (field.href) return link(field.href, field.value);
    return field.title ? '<span class="sales-article-named-code" tabindex="0" title="' + esc(field.title)
      + '" aria-label="' + esc(field.value + ': ' + field.title) + '">' + esc(field.value) + '</span>' : esc(field.value);
  }
  function fields(values) {
    return values.map(f => '<div' + (f.wide ? ' class="wide"' : '') + '><dt>' + esc(f.label)
      + '</dt><dd>' + fieldValue(f) + '</dd></div>').join('');
  }
  const decimal = value => value === null || value === undefined ? '–'
    : Number(value).toLocaleString('de-AT', { maximumFractionDigits: 2 });
  function overview(article, h) {
    const source = article.sourceSections || [], group = id => source.find(g => g.id === id)?.fields || [];
    const price = type => {
      if (article.prices.sales === null) return 'Nicht freigegeben';
      const values = article.prices.sales.filter(p => p.priceType === type && p.priceBasis === 'gross' && p.usable && p.currency === 'EUR');
      return values.length === 1 ? h.money(values[0].amount, 'EUR') : '–';
    };
    const identifier = article.identifiers.find(i => i.isPrimary)?.identifierValue || '';
    const base = [
      {label:'Artikelnummer', value:article.articleNumber}, {label:'Status', value:article.active ? 'Aktiv' : 'Inaktiv'},
      {label:'Bezeichnung', value:article.description, wide:true},
      {label:'EH-VK brutto', value:price('sales')}, {label:'Internet-VK brutto', value:price('internet_1')},
      {label:'Primäre Kennung', value:identifier || '–', ...(identifier ? {href:'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(identifier)} : {})},
      {label:'Aktuelle Revision', value:article.currentRevision},
      ...group('master'), ...group('links'),
    ];
    const stock = article.branchStock || {rows:[]};
    const remaining = source.filter(s => !['master','links','description','supplier'].includes(s.id));
    return '<div class="sales-article-detail-overview"><section class="sales-article-detail-card" id="salesArticleMasterDataSection" aria-labelledby="salesArticleMasterDataTitle">'
      + '<header><h3 id="salesArticleMasterDataTitle">Stammdaten</h3><div class="sales-article-master-update">im GP aktualisiert:'
      + '<time>' + esc(h.timestamp(article.provenance.updatedAt)) + '</time></div></header><dl class="sales-article-detail-data">' + fields(base) + '</dl></section>'
      + '<div id="salesArticlePhotoSlot"></div></div>'
      + '<section class="sales-article-detail-card sales-article-source-description"><header><h3>Beschreibung &amp; Lieferumfang</h3></header>'
      + '<dl class="sales-article-detail-data">' + (fields([...group('supplier'), ...group('description').map(f => ({...f,wide:true}))]) || '<div class="wide"><dd>Keine weiteren Angaben hinterlegt.</dd></div>') + '</dl></section>'
      + '<section class="sales-article-detail-card sales-article-branch-stock"><header><h3>Filialbestand</h3></header>'
      + (stock.rows.length ? '<div class="sales-article-detail-table-wrap"><table class="sales-article-detail-table"><thead><tr><th scope="col">Filiale</th><th scope="col">Bestand</th></tr></thead><tbody>'
        + stock.rows.map(row => '<tr><td>' + fieldValue({value:row.id,title:row.name || 'Filialname nicht hinterlegt'}) + '</td><td'
          + (row.ambiguous ? ' title="Mehrdeutige Bestandszuordnung"' : '') + '>' + esc(decimal(row.quantity)) + '</td></tr>').join('')
        + '</tbody></table></div>' : '<p class="sales-article-detail-message">Kein Filialbestand im aktuellen Import hinterlegt.</p>') + '</section>'
      + '<div class="sales-article-source-sections">' + remaining.map(s => '<section class="sales-article-detail-card"><header><h3>'
        + esc(s.title) + '</h3></header><dl class="sales-article-detail-data">' + fields(s.fields) + '</dl></section>').join('') + '</div>';
  }
  function cell(value, h, percent = false) {
    if (value === null || value === undefined) return '–';
    if (percent) return esc(decimal(value)) + ' %';
    if (typeof value === 'object') return '<span' + (value.note ? ' title="' + esc(value.note) + '"' : '') + '>'
      + esc(value.unit === 'number' ? decimal(value.amount) : h.money(value.amount, value.currency || 'EUR')) + (value.sourceValue ? ' <small>*</small>' : '') + '</span>';
    return esc(value);
  }
  function prices(matrix, h) {
    if (!matrix) return '';
    let result = '<div class="sales-article-price-matrices">';
    if (matrix.purchase === null) result += '<section class="sales-article-detail-card"><header><h3>EK-Preise</h3></header><p class="sales-article-detail-message protected">Einkaufs- und Kalkulationswerte sind für diesen Zugriff nicht freigegeben.</p></section>';
    else result += '<section class="sales-article-detail-card"><header><h3>EK-Preise</h3></header><div class="sales-article-detail-table-wrap"><table class="sales-article-price-matrix"><thead><tr><th scope="col"></th>'
      + matrix.purchase.map(c => '<th scope="col">' + esc(c.label) + '</th>').join('') + '<th scope="col">Datum</th><th scope="col">WKZ / Art</th></tr></thead><tbody>'
      + ['current','future'].map((key,i) => '<tr><th scope="row">' + (i ? 'Zukunft' : 'Aktuell') + '</th>'
        + matrix.purchase.map(c => '<td>' + cell(c[key], h) + '</td>').join('')
        + '<td>' + esc(h.date(i ? matrix.futurePurchaseDate : matrix.purchaseDate)) + '</td><td>'
        + (!i && matrix.wkz !== null ? esc(decimal(matrix.wkz) + (matrix.wkzType ? ' / ' + matrix.wkzType : '')) : '–') + '</td></tr>').join('')
      + '</tbody></table></div><p class="sales-article-price-matrix-note">* Importierter Quellwert; Preisbasis noch nicht bestätigt.</p></section>';
    if (matrix.sales === null) result += '<section class="sales-article-detail-card"><header><h3>VK-Preise</h3></header><p class="sales-article-detail-message protected">Verkaufspreise sind für diesen Zugriff nicht freigegeben.</p></section>';
    else {
      const rows = [['gross','Brutto'],['net','Netto'], ...(matrix.costsRead ? [
        ['marginPercent','Ø EK · Rohertrag %',true],['margin','Ø EK · Rohertrag €'],
        ['marginAPercent','Ø EK-A · Rohertrag %',true],['marginA','Ø EK-A · Rohertrag €']] : []),
      ['discountPercent','Abschlag zur UVP %',true], ['date','Datum / Person']];
      result += '<section class="sales-article-detail-card"><header><h3>VK-Preise</h3></header><div class="sales-article-detail-table-wrap"><table class="sales-article-price-matrix"><thead><tr><th scope="col"></th>'
        + matrix.sales.map(c => '<th scope="col"' + (c.id === 'sales' ? ' class="retail"' : '') + '>' + esc(c.label) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(([key,label,percent]) => '<tr><th scope="row">' + esc(label) + '</th>'
          + matrix.sales.map(c => '<td' + (c.id === 'sales' ? ' class="retail"' : '') + '>'
            + (key === 'date' ? esc(h.date(c.date) + (c.person !== null ? ' / ' + c.person : '')) : cell(c[key],h,percent)) + '</td>').join('')
          + '</tr>').join('') + '</tbody></table></div><p class="sales-article-price-matrix-note">Rohertrag aus Netto-VK und bestätigtem Ø EK netto. '
        + 'Nicht belegte Werte bleiben leer; Ø EK-A ist noch keine bestätigte Rechenbasis.</p></section>';
    }
    return result + '</div>';
  }
  function restrictPrices(matrix, capabilities) {
    if (!matrix) return null;
    return { ...matrix, purchase: capabilities.costsRead ? matrix.purchase : null,
      sales: capabilities.pricesRead && Array.isArray(matrix.sales) ? matrix.sales.map(c => ({
        ...c, margin: capabilities.costsRead ? c.margin : null, marginPercent: capabilities.costsRead ? c.marginPercent : null,
        marginA: capabilities.costsRead ? c.marginA : null, marginAPercent: capabilities.costsRead ? c.marginAPercent : null,
      })) : null, costsRead: capabilities.costsRead, wkz: capabilities.costsRead ? matrix.wkz : null,
      wkzType: capabilities.costsRead ? matrix.wkzType : null,
      purchaseDate: capabilities.costsRead ? matrix.purchaseDate : null, futurePurchaseDate: capabilities.costsRead ? matrix.futurePurchaseDate : null };
  }
  return { overview, prices, fieldValue, link, restrictPrices };
});
