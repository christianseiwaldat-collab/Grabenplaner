(function(root, factory) {
  const value = factory(typeof module === 'object' && module.exports ? require('./sales-article-detail-preferences') : root.SalesArticleDetailPreferences);
  if (typeof module === 'object' && module.exports) module.exports = value;
  else root.SalesArticleLayout = value;
})(typeof window === 'object' ? window : this, function(preferences) {
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
  const DESCRIPTION_FIELDS=new Set(['AKurzbeschreibung','ALieferumfang','ShopText','Meldungstext']);
  function descriptionField(field) {
    const rich=field?.richText;
    if(!DESCRIPTION_FIELDS.has(field?.id) || !rich || rich.format!=='gp-article-description-v1'
      || typeof rich.html!=='string' || typeof rich.text!=='string')return null;
    const limit=rich.truncated?'<p class="sales-article-description-limit">Gekürzte Vorschau; der vollständige Quelltext bleibt erhalten.</p>':'';
    if(!rich.text.trim())return '<div class="sales-article-description-field" data-description-field><p class="sales-article-description-empty">Kein darstellbarer Inhalt</p>'+limit+'</div>';
    if(rich.hasMarkup!==true)return '<div class="sales-article-description-field" data-description-field><div class="sales-article-description-text" data-description-view="text">'+esc(rich.text)+'</div>'+limit+'</div>';
    // rich.html is produced only by the server's fixed sanitizer. Raw field.value
    // remains escaped in the existing fallback and is never inserted as markup.
    return '<div class="sales-article-description-field" data-description-field>'
      + '<div class="sales-article-description-modes" role="group" aria-label="'+esc(field.label)+': Darstellung">'
      + ['html','text'].map(value=>'<button type="button" data-description-mode="'+value+'" aria-pressed="'+String(value==='html')+'">'+(value==='html'?'HTML':'Text')+'</button>').join('')
      + '</div><div class="sales-article-description-html" data-description-view="html">'+rich.html+'</div>'
      + '<div class="sales-article-description-text" data-description-view="text" hidden>'+esc(rich.text)+'</div>'+limit+'</div>';
  }
  function mountDescriptions(root) {
    for(const field of root.querySelectorAll('[data-description-field]')) {
      if(field.dataset.descriptionMounted==='true')continue;
      field.dataset.descriptionMounted='true';
      field.addEventListener('click',event=>{
        const button=event.target.closest('[data-description-mode]');
        if(!button || button.closest('[data-description-field]')!==field)return;
        const mode=button.dataset.descriptionMode;
        if(!['html','text'].includes(mode))return;
        for(const view of field.querySelectorAll('[data-description-view]'))view.hidden=view.dataset.descriptionView!==mode;
        for(const control of field.querySelectorAll('[data-description-mode]'))control.setAttribute('aria-pressed',String(control.dataset.descriptionMode===mode));
      });
    }
  }
  function fieldValue(field) {
    const rich = descriptionField(field);
    if (rich !== null) return rich;
    if (field.href) return link(field.href, field.value);
    return field.title ? '<span class="sales-article-named-code" tabindex="0" title="' + esc(field.title)
      + '" aria-label="' + esc(field.value + ': ' + field.title) + '">' + esc(field.value) + '</span>' : esc(field.value);
  }
  function fields(values) {
    return values.map(f => '<div class="' + esc([f.wide ? 'wide' : '', f.className || ''].filter(Boolean).join(' ')) + '"><dt>' + esc(f.label)
      + '</dt><dd>' + fieldValue(f) + '</dd></div>').join('');
  }
  const decimal = value => value === null || value === undefined ? '–'
    : Number(value).toLocaleString('de-AT', { maximumFractionDigits: 2 });
  function branchOrders(row, h) {
    const orders = row.orders;
    if (!orders || orders.state === 'restricted') return '<span title="Einkaufsrecht für diese Filiale erforderlich">–</span>';
    const lines = ['Bestellt laut Bestandsimport: ' + decimal(row.ordered), 'Zuletzt belegte BE-Zuordnung; kein gesicherter aktueller Offenstand.'];
    for (const item of orders.items || []) lines.push('BE ' + item.number + ' · Rest ' + decimal(item.remaining)
      + (item.state === 'review' ? ' · prüfen' : '') + ' · Stand ' + h.timestamp(item.sourceAt));
    if (!orders.items?.length) lines.push('Keine belastbare BE-Zuordnung verfügbar.');
    if (orders.state === 'review') lines.push('Abgleich / Prüfbedarf: Mengen, Status oder Zuordnung sind nicht vollständig bestätigt.');
    if (orders.truncated) lines.push('Begrenzte Anzeige; weitere historische Positionen können vorhanden sein.');
    if (orders.matched === true) lines.push('Die belegten Restmengen stimmen mit dem importierten Bestellt-Wert überein.');
    return '<details class="sales-article-branch-orders"><summary title="' + esc(lines.join('\n')) + '" aria-label="Bestellt '
      + esc(decimal(row.ordered)) + ' · BE-Zuordnung anzeigen">' + esc(decimal(row.ordered))
      + ' <span aria-hidden="true">ⓘ</span></summary><div class="sales-article-branch-orders-note">'
      + lines.map(line => '<p>' + esc(line) + '</p>').join('') + '</div></details>';
  }
  function branchStock(stock, h, value = preferences.defaults()) {
    const rows=stock?.rows || [], hidden=new Set(value.hiddenBranchIds), columns=value.columns.map(id=>preferences.COLUMNS.find(column=>column.id===id));
    const visible=rows.filter(row=>!hidden.has(row.id)), direction=value.direction==='desc'?-1:1;
    const number=(row,id)=>id==='ordered' && (!row.orders || row.orders.state==='restricted') ? null : row[id];
    visible.sort((a,b)=>{
      if(value.sort==='branch') return direction*a.id.localeCompare(b.id,'de',{numeric:true});
      const av=number(a,value.sort),bv=number(b,value.sort);
      if(av==null || bv==null) return av==null && bv==null ? a.id.localeCompare(b.id,'de',{numeric:true}) : av==null?1:-1;
      return direction*(Number(av)-Number(bv)) || a.id.localeCompare(b.id,'de',{numeric:true});
    });
    const chooser='<details class="sales-article-stock-settings" data-stock-settings><summary>Anzeige anpassen</summary><div class="sales-article-stock-options">'
      + '<fieldset><legend>Filialen</legend><button type="button" data-stock-all>Alle Filialen anzeigen</button><div class="sales-article-stock-branches">'
      + rows.map(row=>'<label><input type="checkbox" data-stock-branch="'+esc(row.id)+'" '+(!hidden.has(row.id)?'checked':'')+'><span>'+esc(row.id)+(row.name?' · '+esc(row.name):'')+'</span></label>').join('')
      + (!rows.length?'<p>Keine Filialen zum Artikel vorhanden.</p>':'')+'</div><small>Neue Filialen werden automatisch angezeigt.</small></fieldset>'
      + '<fieldset><legend>Spalten</legend>'+preferences.COLUMNS.map(column=>'<label><input type="checkbox" data-stock-column="'+column.id+'" '
        +(value.columns.includes(column.id)?'checked ':'')+(value.columns.length===1 && value.columns[0]===column.id?'disabled':'')+'><span>'+column.label+'</span></label>').join('')
      + '<small>Mindestens eine Spalte bleibt sichtbar.</small></fieldset></div></details>';
    const table='<div class="sales-article-detail-table-wrap"><table class="sales-article-detail-table" aria-label="Filialbestand"><thead><tr>'
      + columns.map(column=>'<th scope="col" data-stock-cell="'+column.id+'" aria-sort="'+(column.id===value.sort?(direction===1?'ascending':'descending'):'none')+'">'
        + '<button type="button" data-stock-sort="'+column.id+'">'+column.label+' <span aria-hidden="true">'+(column.id===value.sort?(direction===1?'↑':'↓'):'↕')+'</span></button>'
        + '<button type="button" data-gp-column-resize="'+column.id+'" role="separator" aria-orientation="vertical" aria-label="Spaltenbreite '+column.label+'" aria-valuemin="80" aria-valuemax="800"></button></th>').join('')
      + '</tr></thead><tbody>'+visible.map(row=>'<tr>'+columns.map(column=>'<td data-stock-cell="'+column.id+'"'
        +(column.id==='quantity' && row.ambiguous?' title="Mehrdeutige Bestandszuordnung"':'')+'>'
        +(column.id==='branch'?fieldValue({value:row.id,title:row.name || 'Filialname nicht hinterlegt'}):column.id==='ordered'?branchOrders(row,h):esc(decimal(row.quantity)))+'</td>').join('')+'</tr>').join('')
      + (!visible.length?'<tr><td colspan="'+columns.length+'">'+(rows.length?'Alle Filialen sind ausgeblendet.':'Kein Filialbestand im aktuellen Import hinterlegt.')+'</td></tr>':'')+'</tbody></table></div>';
    return '<header><h3>Filialbestand</h3><span class="sales-article-stock-count">'+visible.length+' / '+rows.length+'</span></header>'+chooser+table;
  }
  function overview(article, h) {
    const source = article.sourceSections || [], group = id => source.find(g => g.id === id)?.fields || [];
    const find = (section, id, label, fallback = '–') => ({ ...(group(section).find(f => f.id === id || f.label === label) || {value:fallback}), label });
    const google = field => field.value && !['–','Nicht hinterlegt'].includes(field.value)
      ? {...field, href:'https://www.google.com/search?q=' + encodeURIComponent(field.value)} : field;
    const price = type => {
      if (article.prices.sales === null) return 'Nicht freigegeben';
      const values = article.prices.sales.filter(p => p.priceType === type && p.priceBasis === 'gross' && p.usable && p.currency === 'EUR');
      return values.length === 1 ? h.money(values[0].amount, 'EUR') : '–';
    };
    const identifier = article.identifiers.find(i => i.isPrimary)?.identifierValue || '';
    const base = [
      {label:'Artikelnummer', value:article.articleNumber, className:'master-number'}, {label:'Status', value:article.active ? 'Aktiv' : 'Inaktiv', className:'master-status'},
      {...find('master','Sortimentsart','Sortimentsart'), className:'master-assortment'},
      {label:'Bezeichnung', value:article.description}, find('master','ArtikelBezInternet','Internetbezeichnung'),
      {label:'EH-VK brutto', value:price('sales')}, {label:'Internet-VK brutto', value:price('internet_1')},
      {label:'Primäre Kennung', value:identifier || '–', ...(identifier ? {href:'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(identifier)} : {})},
      {label:'Aktuelle Revision', value:article.currentRevision},
      ...group('master').filter(f => !['Sortimentsart','Internetbezeichnung'].includes(f.label)), ...group('links'),
    ];
    const stock = article.branchStock || {rows:[]};
    const remaining = source.filter(s => !['master','links','description','supplier'].includes(s.id));
    const order = google(find('supplier','Bestellnummer','Bestellnummer'));
    order.label = 'Bestellnummer (Lieferant)';
    const supplier = '<div class="sales-article-supplier-layout"><div class="sales-article-supplier-summary">'
      + '<dl class="sales-article-detail-data sales-article-inline-fields">' + fields([find('supplier','Suchname','Lieferant'),find('supplier','Kondition','Kondition')]) + '</dl>'
      + '<dl class="sales-article-detail-data">' + fields([{...order,wide:true}]) + '</dl>'
      + '<dl class="sales-article-detail-data sales-article-inline-fields three">' + fields([find('supplier','GWertmenge','Wertmenge'),find('supplier','Bestelleinheit','Bestelleinheit'),find('supplier','AZweitLief','Zweitlieferanten')]) + '</dl>'
      + (group('supplier').some(f => f.id === 'Bestelldaten' || f.label === 'Bestelldaten') ? '<dl class="sales-article-detail-data">' + fields([{...find('supplier','Bestelldaten','Bestelldaten'),wide:true}]) + '</dl>' : '')
      + '</div><dl class="sales-article-detail-data sales-article-supplier-remark">' + fields([find('supplier','LBemerkung','Lieferantenbemerkung')]) + '</dl></div>';
    return '<div class="sales-article-detail-overview"><section class="sales-article-detail-card" id="salesArticleMasterDataSection" aria-labelledby="salesArticleMasterDataTitle">'
      + '<header><h3 id="salesArticleMasterDataTitle">Stammdaten</h3><div class="sales-article-master-update">im GP aktualisiert:'
      + '<time>' + esc(h.timestamp(article.provenance.updatedAt)) + '</time></div></header><dl class="sales-article-detail-data sales-article-master-data">' + fields(base) + '</dl></section>'
      + '<section class="sales-article-detail-card sales-article-branch-stock" id="salesArticleBranchStock">'+branchStock(stock,h)+'</section>'
      + '<div id="salesArticlePhotoSlot"></div></div>'
      + '<section class="sales-article-detail-card sales-article-source-description"><header><h3>Beschreibung &amp; Lieferumfang</h3></header>'
      + supplier + (group('description').length ? '<dl class="sales-article-detail-data">' + fields(group('description').map(f => ({...f,wide:true}))) + '</dl>' : '') + '</section>'
      + '<div class="sales-article-source-sections">' + remaining.map(s => '<section class="sales-article-detail-card"><header><h3>'
        + esc(s.title) + '</h3></header><dl class="sales-article-detail-data">' + fields(s.fields) + '</dl></section>').join('') + '</div>';
  }
  function notes(value, h) {
    const items = value?.items || [];
    return '<section class="sales-article-detail-card sales-article-notes"><header><div><h3>Notizen</h3><p>'
      + (value?.available ? 'Artikelnotizen aus Trade · Importstand ' + esc(h.timestamp(value.sourceAt)) : 'Noch keine Artikelnotizen aus Trade übernommen.') + '</p></div></header>'
      + '<div class="sales-article-notes-filters"><label>Datum von<input type="date" data-note-from></label><label>Datum bis<input type="date" data-note-to></label>'
      + '<button type="button" class="sales-article-price-text-link" data-notes-reset>Alle Notizen</button></div><p class="sales-article-price-matrix-note" data-notes-status role="status"></p>'
      + '<div class="sales-article-detail-table-wrap"><table class="sales-article-notes-table"><thead><tr>'
      + [['date','Datum'],['text','Notiz'],['person','Person (Trade)']].map(([id,label]) => '<th scope="col" aria-sort="' + (id === 'date' ? 'descending' : 'none') + '"><button type="button" data-note-sort="' + id + '">' + label + ' <span aria-hidden="true">' + (id === 'date' ? '↓' : '↕') + '</span></button></th>').join('')
      + '</tr></thead><tbody>' + items.map((item, i) => '<tr data-note-index="' + i + '"><td>' + esc(h.date(item.date)) + '</td><td>' + esc(item.text) + '</td><td>' + esc(item.person ?? '–') + '</td></tr>').join('')
      + '<tr data-notes-empty' + (items.length ? ' hidden' : '') + '><td colspan="3">' + (value?.available ? 'Keine Notizen zu diesem Artikel vorhanden.' : 'Keine übernommenen Notizen verfügbar.') + '</td></tr>'
      + '</tbody></table></div></section>';
  }
  function mountNotes(root, value) {
    const card = root.querySelector('.sales-article-notes'); if (!card) return;
    const items = value?.items || [], rows = [...card.querySelectorAll('[data-note-index]')];
    const from = card.querySelector('[data-note-from]'), to = card.querySelector('[data-note-to]');
    let sort = 'date', direction = -1;
    function render() {
      const invalid = from.value && to.value && from.value > to.value;
      to.setCustomValidity(invalid ? 'Das Enddatum muss am oder nach dem Startdatum liegen.' : '');
      const compare = (a,b) => String(items[a.dataset.noteIndex][sort] ?? '').localeCompare(String(items[b.dataset.noteIndex][sort] ?? ''),'de',{numeric:true});
      let count = 0;
      rows.sort((a,b) => direction * compare(a,b) || Number(a.dataset.noteIndex) - Number(b.dataset.noteIndex));
      for (const row of rows) {
        const date = String(items[row.dataset.noteIndex].date || '').slice(0,10);
        row.hidden = Boolean(invalid || from.value && date < from.value || to.value && (!date || date > to.value));
        if (!row.hidden) count += 1;
        card.querySelector('tbody').append(row);
      }
      card.querySelector('[data-notes-empty]').hidden = Boolean(count) || Boolean(invalid);
      if (!count && items.length) card.querySelector('[data-notes-empty] td').textContent = 'Keine Notizen im gewählten Zeitraum.';
      card.querySelector('[data-notes-status]').textContent = invalid ? 'Bitte einen gültigen Zeitraum wählen.' : count + ' von ' + items.length + ' Notizen';
      card.querySelectorAll('[data-note-sort]').forEach(b => {const selected = b.dataset.noteSort === sort; b.parentElement.setAttribute('aria-sort', selected ? direction === 1 ? 'ascending' : 'descending' : 'none'); b.querySelector('span').textContent = selected ? direction === 1 ? '↑' : '↓' : '↕';});
    }
    from.addEventListener('input',render); to.addEventListener('input',render);
    card.querySelector('[data-notes-reset]').addEventListener('click',()=>{from.value='';to.value='';render();});
    card.querySelectorAll('[data-note-sort]').forEach(b=>b.addEventListener('click',()=>{direction=sort===b.dataset.noteSort?-direction:1;sort=b.dataset.noteSort;render();}));
    render();
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
      result += '<section class="sales-article-detail-card" data-sales-price-card><header><h3>VK-Preise</h3>'
        + '<button type="button" class="sales-article-price-text-link" data-price-columns-toggle aria-expanded="false" aria-controls="salesArticlePriceColumns">Spaltenanzeige</button></header>'
        + '<fieldset id="salesArticlePriceColumns" class="sales-article-price-columns" hidden><legend>Sichtbare VK-Spalten</legend>'
        + matrix.sales.map(c => '<label><input type="checkbox" data-price-column-option="' + esc(c.id) + '" checked> ' + esc(c.label) + '</label>').join('')
        + '<p>Mindestens eine Spalte bleibt sichtbar. Die Auswahl wird für Sie in diesem Browser gespeichert.</p></fieldset>'
        + '<div class="sales-article-detail-table-wrap"><table class="sales-article-price-matrix"><thead><tr><th scope="col"></th>'
        + matrix.sales.map(c => '<th scope="col" data-price-column="' + esc(c.id) + '"' + (c.id === 'sales' ? ' class="retail"' : '') + '>' + esc(c.label) + '</th>').join('')
        + '</tr></thead><tbody>' + rows.map(([key,label,percent]) => '<tr><th scope="row">' + esc(label) + '</th>'
          + matrix.sales.map(c => '<td data-price-column="' + esc(c.id) + '" data-price-row="' + key + '"' + (c.id === 'sales' ? ' class="retail"' : '') + '>'
            + (key === 'date' ? esc(h.date(c.date) + (c.person !== null ? ' / ' + c.person : '')) : cell(c[key],h,percent)) + '</td>').join('')
          + '</tr>').join('') + '</tbody></table></div>'
        + '<div class="sales-article-price-trial-note" data-price-trial-note><p id="salesArticleTrialHint"></p>'
        + '<button type="button" class="sales-article-price-text-link" data-price-trial-reset>Versuch zurücksetzen</button>'
        + '<p id="salesArticleTrialStatus" role="status" aria-live="polite"></p></div>'
        + '<p class="sales-article-price-matrix-note">Rohertrag aus Netto-VK und bestätigtem Ø EK netto. '
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
  return { mountDescriptions, overview, branchStock, prices, notes, mountNotes, fieldValue, link, restrictPrices };
});
