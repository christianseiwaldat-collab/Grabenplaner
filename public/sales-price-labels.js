(function(host, factory) {
  'use strict'; const common = typeof module === 'object' && module.exports;
  const api = factory(common ? require('./sales-price-label-fonts') : host.GrabenplanerPriceLabelFonts,
    common ? require('./sales-price-label-layout') : host.GrabenplanerPriceLabelLayout);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (host) { host.GrabenplanerSalesPriceLabels = api; host.SalesPriceLabels = api; }
})(typeof globalThis !== 'undefined' ? globalThis : this, function(Fonts, PaperGrid) {
  'use strict';
  const defaults = Object.freeze({ paper: 'A4', paperWidthMm: 210, paperHeightMm: 297, orientation: 'portrait', labelWidthMm: 90,
    labelHeightMm: 60, marginMm: 10, gapMm: 3, copies: 1, design: 'classic', shape: 'rectangle', color: '#225247',
    showArticleNumber: true, showEan: false, showTax: true, showPhoto: false, headline: '', footer: '',
    logoKitId: '', logoAssetKey: '', logoPosition: 'top-left', logoWidthMm: 20, logoHeightMm: 10, logoSpacingMm: 2,
    logoMode: 'reserved', logoXmm: 4, logoYmm: 4, fontId: 'roboto', showBorder: true, cutMarks: false, borderMode: 'design' });
  const fileDefaults = Object.freeze({ stamp: 'date-time', position: 'before', separator: '-', suffix: '' });
  let instanceCounter = 0;
  const labelFormats = Object.freeze([
    Object.freeze({id:'window',label:'Schaufenster',width:90,height:60}),
    Object.freeze({id:'shelf',label:'Regal',width:70,height:40}),
    Object.freeze({id:'stand',label:'A6-Aufsteller',width:105,height:148}),
    Object.freeze({id:'a5',label:'A5',width:148,height:210}),
    Object.freeze({id:'a4',label:'A4',width:210,height:297}),
  ]);
  function labelFormat(value) {
    const width = value.labelWidthMm, height = value.labelHeightMm;
    const format = labelFormats.find(row => Math.abs(Math.min(row.width,row.height)-Math.min(width,height)) < 1e-6
      && Math.abs(Math.max(row.width,row.height)-Math.max(width,height)) < 1e-6);
    return {id:format?.id || 'custom',orientation:width > height ? 'landscape' : 'portrait'};
  }
  function applyLabelFormat(value, id, orientation) {
    const format = labelFormats.find(row => row.id === id);
    if (!format && id !== 'custom') throw new Error('Bitte ein verfügbares Schildformat auswählen.');
    if (orientation !== undefined && !['portrait','landscape'].includes(orientation)) throw new Error('Bitte eine gültige Schildausrichtung auswählen.');
    let width = format?.width ?? value.labelWidthMm, height = format?.height ?? value.labelHeightMm;
    if (orientation) [width,height] = orientation === 'portrait' ? [Math.min(width,height),Math.max(width,height)] : [Math.max(width,height),Math.min(width,height)];
    const next = {...value,labelWidthMm:width,labelHeightMm:height,...(id === 'shelf' ? {design:'minimal'} : {})};
    if (next.logoMode === 'free') Object.assign(next,boundedLogo(next,
      {x:value.logoXmm,y:value.logoYmm,width:value.logoWidthMm,height:value.logoHeightMm}));
    return normalizeOptions(next);
  }
  function paperAdjustment(value) {
    if (paperLayout(value).capacity) return null;
    const orientations = [value.orientation,value.orientation === 'portrait' ? 'landscape' : 'portrait'];
    const fit = (paper,orientation,marginMm,paperWidthMm = value.paperWidthMm,paperHeightMm = value.paperHeightMm) => {
      const next = {paper,orientation,marginMm,paperWidthMm,paperHeightMm};
      return paperLayout({...value,...next}).capacity ? next : null;
    };
    for (const margin of [value.marginMm,0]) for (const orientation of orientations) {
      const chosen = fit(value.paper,orientation,margin); if (chosen) return chosen;
    }
    for (const paper of ['A6','A5','A4']) for (const margin of [value.marginMm,0]) for (const orientation of orientations) {
      const chosen = fit(paper,orientation,margin); if (chosen) return chosen;
    }
    return fit('custom',labelFormat(value).orientation,0,value.labelWidthMm,value.labelHeightMm);
  }
  const escape = value => String(value ?? '').replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  function parseArticleNumbers(value) {
    if (typeof value !== 'string' || value.length > 12000) throw new Error('Bitte höchstens 100 Artikelnummern eingeben.');
    const numbers = [...new Set(value.split(/[\s,;]+/u).map(number => number.trim()).filter(Boolean))];
    if (numbers.length > 100 || numbers.some(number => number.length > 80 || /[\u0000-\u001f\u007f]/u.test(number))) throw new Error('Bitte höchstens 100 gültige Artikelnummern eingeben.');
    return numbers;
  }
  function articleTemplateIntent(article, template, {copy = false} = {}) {
    const numbers = parseArticleNumbers(typeof article === 'string' ? article : article?.articleNumber);
    if (numbers.length !== 1) throw new Error('Bitte genau einen Artikel auswählen.');
    if (template && (typeof template.id !== 'string' || !template.id)) throw new Error('Die gespeicherte Vorlage ist nicht verfügbar.');
    return {articleNumber: numbers[0], templateId: template?.id || '',
      copy: Boolean(template && (copy || template.received !== false || template.canEdit !== true))};
  }
  function normalizeOptions(value = {}) {
    if (!value || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
      || Object.keys(value).some(key => !Object.hasOwn(defaults, key))) throw new Error('Die Preisschild-Einstellungen sind ungültig.');
    const options = { ...defaults, ...value, borderMode: value.borderMode === undefined ? value.showBorder === undefined ? 'design' : 'manual' : value.borderMode };
    for (const field of ['paperWidthMm', 'paperHeightMm', 'labelWidthMm', 'labelHeightMm']) if (!Number.isFinite(options[field]) || options[field] < 10 || options[field] > 500) throw new Error('Papier- und Schildmaße müssen zwischen 10 und 500 mm liegen.');
    for (const field of ['marginMm', 'gapMm']) if (!Number.isFinite(options[field]) || options[field] < 0 || options[field] > 50) throw new Error('Rand und Abstand müssen zwischen 0 und 50 mm liegen.');
    if (!Number.isInteger(options.copies) || options.copies < 1 || options.copies > 50) throw new Error('Bitte 1 bis 50 Kopien je Artikel wählen.');
    if (!['A4', 'A5', 'A6', 'custom'].includes(options.paper) || !['portrait', 'landscape'].includes(options.orientation)
      || !['classic', 'minimal', 'promo'].includes(options.design) || !['rectangle', 'rounded', 'circle'].includes(options.shape)
      || typeof options.color !== 'string' || !/^#[a-f0-9]{6}$/i.test(options.color)) throw new Error('Bitte eine gültige Gestaltung wählen.');
    for (const field of ['showArticleNumber', 'showEan', 'showTax', 'showPhoto', 'showBorder', 'cutMarks']) if (typeof options[field] !== 'boolean') throw new Error('Bitte die Anzeigeoptionen prüfen.');
    if (!['design','manual'].includes(options.borderMode)) throw new Error('Bitte die Umrandungsauswahl prüfen.');
    if (options.borderMode === 'design') options.showBorder = options.design !== 'minimal';
    for (const [field, max] of [['headline', 70], ['footer', 160]]) if (typeof options[field] !== 'string' || options[field].length > max || /[\u0000-\u001f\u007f]/u.test(options[field])) throw new Error('Überschrift oder Fußtext ist zu lang oder ungültig.');
    for (const [field, max] of [['logoKitId', 120], ['logoAssetKey', 160]]) if (typeof options[field] !== 'string' || options[field].length > max || /[\u0000-\u001f\u007f]/u.test(options[field])) throw new Error('Bitte ein verfügbares Branding-Kit und Logo auswählen.');
    if (Boolean(options.logoKitId) !== Boolean(options.logoAssetKey)) throw new Error('Bitte ein Logo aus dem Branding-Kit auswählen.');
    if (!['top-left', 'top-center', 'top-right', 'bottom-left', 'bottom-center', 'bottom-right'].includes(options.logoPosition)) throw new Error('Bitte eine gültige Logoposition auswählen.');
    for (const [field, min, max] of [['logoWidthMm', 5, options.logoMode === 'free' ? 500 : 100], ['logoHeightMm', 5, options.logoMode === 'free' ? 500 : 60], ['logoSpacingMm', 0, 10]]) if (!Number.isFinite(options[field]) || options[field] < min || options[field] > max) throw new Error('Bitte die Logomaße und den Abstand prüfen.');
    if (!Fonts.get(options.fontId)) throw new Error('Bitte eine verfügbare Schriftart auswählen.');
    if (!['reserved', 'free'].includes(options.logoMode)) throw new Error('Bitte die Logoanordnung prüfen.');
    for (const field of ['logoXmm', 'logoYmm']) if (!Number.isFinite(options[field]) || options[field] < 0 || options[field] > 500) throw new Error('Bitte die Logoposition in Millimetern prüfen.');
    if (options.logoMode === 'free' && (options.logoXmm + options.logoWidthMm > options.labelWidthMm + .001
      || options.logoYmm + options.logoHeightMm > options.labelHeightMm + .001)) throw new Error('Das Logo muss innerhalb der Schildfläche liegen. Bitte Position oder Größe anpassen.');
    return Object.fromEntries(Object.keys(defaults).map(key => [key, options[key]]));
  }
  function boundedLogo(value, geometry) {
    const round = n => Math.round(n * 100) / 100;
    const floor = n => Math.floor((n + 1e-8) * 100) / 100;
    const width = floor(Math.max(5, Math.min(value.labelWidthMm, geometry.width)));
    const height = floor(Math.max(5, Math.min(value.labelHeightMm, geometry.height)));
    return { logoMode: 'free', logoWidthMm: width, logoHeightMm: height,
      logoXmm: Math.max(0, Math.min(floor(value.labelWidthMm - width), round(geometry.x))),
      logoYmm: Math.max(0, Math.min(floor(value.labelHeightMm - height), round(geometry.y))) };
  }
  function logoFrame(label) {
    const box = label.getBoundingClientRect();
    // App font zoom scales client coordinates and BCRs, but not layout sizes.
    const scaleX = box.width / (label.offsetWidth || label.clientWidth || box.width);
    const scaleY = box.height / (label.offsetHeight || label.clientHeight || box.height);
    return { left: box.left + (label.clientLeft || 0) * scaleX, top: box.top + (label.clientTop || 0) * scaleY,
      width: label.clientWidth ? label.clientWidth * scaleX : box.width,
      height: label.clientHeight ? label.clientHeight * scaleY : box.height };
  }
  function paperLayout(options) {
    const {width,height,columns,rows,capacity} = PaperGrid.create(options);
    return { width, height, columns, rows, capacity };
  }
  function pagePreview(options, grid, pageIndex, items) {
    const cells = grid.page(pageIndex), cuts = PaperGrid.cutsVisible(options);
    const shape = (cell, strokeWidth) => {
      const b = PaperGrid.shapeBounds(options.shape,cell.x,cell.y,cell.width,cell.height,strokeWidth);
      return b.kind === 'circle' ? '<circle cx="' + (b.x+b.radius) + '" cy="' + (b.y+b.radius) + '" r="' + b.radius + '"'
        : '<rect x="' + b.x + '" y="' + b.y + '" width="' + b.width + '" height="' + b.height + '" rx="' + b.radius + '"';
    };
    const description = grid.width + ' × ' + grid.height + ' mm, Rand ' + options.marginMm + ' mm, Abstand ' + options.gapMm + ' mm. ';
    return '<svg class="spl-paper-page" viewBox="0 0 ' + grid.width + ' ' + grid.height + '" role="img" aria-label="' + escape(description + (grid.pageCount ? 'Seite ' + (pageIndex+1) + ' von ' + grid.pageCount : 'Leere Papierbelegung')) + '"><rect width="' + grid.width + '" height="' + grid.height + '" fill="white"/>' + cells.map(cell => {
      const title = cell.occupied ? 'Schild ' + (cell.index+1) + ', Artikel ' + (items[cell.itemIndex]?.articleNumber || '') + ', Kopie ' + (cell.copyIndex+1) + ' von ' + options.copies : 'Freier Platz ' + (cell.position+1);
      const stroke = cell.occupied ? options.showBorder ? PaperGrid.BORDER_WIDTH_MM : cuts ? PaperGrid.CUT_WIDTH_MM : 0 : .2;
      return '<g data-pl-slot="' + cell.position + '" data-pl-occupied="' + cell.occupied + '"><title>' + escape(title) + '</title>' + shape(cell,stroke) + ' fill="' + (cell.occupied ? '#DFECE4' : '#F7F8F7') + '" stroke="' + (cell.occupied ? options.showBorder ? options.color : cuts ? '#79877F' : 'none' : '#B8C5BD') + '" stroke-width="' + stroke + '"' + (cell.occupied ? cuts ? ' stroke-dasharray="2 1"' : '' : ' stroke-dasharray="1 1"') + '/>' +
        (cell.occupied && cell.width >= 25 && cell.height >= 20 ? '<text x="' + (cell.x+cell.width/2) + '" y="' + (cell.y+cell.height/2) + '" text-anchor="middle" dominant-baseline="middle" fill="#315C44" font-size="' + Math.min(7,cell.width*.15,cell.height*.2) + '">' + (cell.index+1) + '</text>' : '') + '</g>';
    }).join('') + '</svg>';
  }
  function price(value) {
    const match = /^(\d{1,24})(?:\.(\d{1,24}))?$/.exec(String(value ?? ''));
    if (!match) return null;
    const fraction = match[2] || ''; let cents = BigInt(match[1]) * 100n + BigInt((fraction + '00').slice(0, 2));
    if ((fraction[2] || '0') >= '5') cents++;
    const whole = String(cents / 100n).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
    return whole + ',' + String(cents % 100n).padStart(2, '0');
  }
  function filename(name, options) {
    const model = globalThis.GrabenplanerTradeExportOptions || globalThis.GrabenplanerTradeExport;
    if (model?.filename) return model.filename(name, options);
    const clean = text => String(text || 'Preisschilder').replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '').replace(/\.pdf$/i, '').replace(/^[. ]+|[. ]+$/g, '').slice(0, 110) || 'Preisschilder';
    const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Vienna', year: '2-digit', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
    const get = key => parts.find(part => part.type === key).value, date = get('year') + get('month') + get('day');
    const block = options.stamp === 'none' ? '' : options.stamp === 'date-time' ? date + '-' + get('hour') + get('minute') : options.stamp === 'date-suffix' ? date + (options.suffix.trim() ? '-' + clean(options.suffix) : '') : date;
    return (options.position === 'after' ? [clean(name), block] : [block, clean(name)]).filter(Boolean).join(options.separator) + '.pdf';
  }
  function mount(root, { api, rawApi, accessKey = () => '' }) {
    const formatHintId = 'sales-price-label-format-hint-' + (++instanceCounter);
    root.classList.add('sales-price-labels');
    root.innerHTML = `<style>${Fonts.css()}</style><section class="spl-card spl-library"><header><h2>Vorlagen</h2><span data-pl="library-summary"></span></header><div class="spl-library-picker"><label>Gespeicherte Vorlage<select data-pl="library-select"><option value="">Persönliche Standardeinstellung</option></select></label><button type="button" data-pl="library-new">Neue Vorlage</button><button type="button" data-pl="library-copy" disabled>Kopie anlegen</button></div>
      <div data-pl="library-editor" hidden><div class="spl-fields"><label>Titel<input data-pl="library-title" maxlength="80" placeholder="z. B. Schaufenster Herbst"></label><label>Verfügbarkeit<select data-pl="library-scope"><option value="private">Nur für mich</option><option value="branch">Eigene Filiale</option><option value="selected">Ausgewählte Filialkonten</option></select></label></div>
        <details class="spl-library-recipients" data-pl="library-recipients-panel" hidden><summary>Empfänger auswählen <span data-pl="library-recipient-count"></span></summary><div data-pl="library-recipients"></div></details><p class="spl-hint" data-pl="library-hint"></p></div>
      <div class="spl-library-actions"><button type="button" data-pl="save">Standardeinstellung speichern</button><button type="button" data-pl="library-reload" hidden>Aktuellen Stand laden</button><span data-pl="saved" role="status"></span></div></section>
      <div class="spl-presets" aria-label="Schildformate"><span>Schildformate</span>${labelFormats.map(format => '<button type="button" data-pl-preset="' + format.id + '" aria-pressed="false">' + format.label + ' <small>' + format.width + ' × ' + format.height + ' mm</small></button>').join('')}</div>
      <div class="spl-layout"><form class="spl-settings" data-pl="settings">
        <section class="spl-card"><h2>Artikel & Preise</h2><label>Artikelnummern<textarea name="articleNumbers" maxlength="12000" rows="3" placeholder="z. B. 102607&#10;107014" spellcheck="false"></textarea></label><div class="spl-hint-row"><small>Mit Leerzeichen, Komma oder neuer Zeile trennen.</small><small data-pl="count">0 / 100</small></div>
          <label>Preisart<select name="priceType"><option value="sales">EH-VK brutto</option><option value="internet_1">Internet-VK brutto</option><option value="internet_3">UCW-VK brutto</option></select></label><button class="spl-primary" type="button" data-pl="refresh">Artikel laden / aktualisieren</button><p class="spl-hint">Die Preise kommen aus dem aktuellen GP-Artikelstamm.</p></section>
        <section class="spl-card"><h2>Gestaltung</h2><div class="spl-fields"><label>Design<select name="design"><option value="classic">Klassisch</option><option value="minimal">Minimal</option><option value="promo">Aktion</option></select></label><label>Form<select name="shape"><option value="rectangle">Rechteck</option><option value="rounded">Abgerundet</option><option value="circle">Kreis</option></select></label>
          <label>Breite (mm)<input type="number" name="labelWidthMm" min="10" max="500" step="0.5" required></label><label>Höhe (mm)<input type="number" name="labelHeightMm" min="10" max="500" step="0.5" required></label>
          <label class="spl-wide">Schildausrichtung<select data-pl="label-orientation" aria-label="Schildausrichtung" aria-describedby="${formatHintId}"><option value="portrait">Hochformat</option><option value="landscape">Querformat</option></select><small id="${formatHintId}">Gilt für alle Schildformate und eigene Maße. Papier wird separat eingestellt.</small></label>
          <label class="spl-wide">Schriftart<select name="fontId">${Fonts.families.map(font => '<option value="' + font.id + '">' + font.label + '</option>').join('')}</select></label>
          <label class="spl-wide">Akzentfarbe<span class="spl-color"><input type="color" name="color" aria-label="Akzentfarbe auswählen"><input type="text" data-pl="color-text" maxlength="7" aria-label="Akzentfarbe als Farbcode" pattern="#[a-fA-F0-9]{6}"></span></label>
          <label class="spl-wide">Überschrift <small>optional</small><input name="headline" maxlength="70" placeholder="z. B. Unser Angebot"></label><label class="spl-wide">Fußtext <small>optional</small><input name="footer" maxlength="160" placeholder="z. B. Solange der Vorrat reicht"></label></div>
          <input type="hidden" name="borderMode"><div class="spl-checks"><label><input name="showArticleNumber" type="checkbox"> Artikelnummer</label><label><input name="showEan" type="checkbox"> EAN</label><label><input name="showTax" type="checkbox"> MwSt.-Hinweis</label><label><input name="showPhoto" type="checkbox"> Artikelfoto</label><label><input name="showBorder" type="checkbox"> Schildumrandung</label></div>
          <details class="spl-logo-options"><summary>Logo aus Branding-Kit <span data-pl="logo-summary">Ohne Logo</span></summary><div class="spl-fields"><label class="spl-wide">Branding-Kit<select name="logoKitId"><option value="">Ohne Logo</option></select></label><label class="spl-wide">Logo<select name="logoAssetKey"><option value="">Logo auswählen</option></select></label><label class="spl-wide">Anordnung<select name="logoMode"><option value="reserved">Feste Position mit Textabstand</option><option value="free">Frei über Text und Preis</option></select></label><label class="spl-wide" data-pl-reserved>Position<select name="logoPosition"><option value="top-left">Oben links</option><option value="top-center">Oben mittig</option><option value="top-right">Oben rechts</option><option value="bottom-left">Unten links</option><option value="bottom-center">Unten mittig</option><option value="bottom-right">Unten rechts</option></select></label><label data-pl-free>X von links (mm)<input type="number" name="logoXmm" min="0" max="500" step="0.5"></label><label data-pl-free>Y von oben (mm)<input type="number" name="logoYmm" min="0" max="500" step="0.5"></label><label>Breite (mm)<input type="number" name="logoWidthMm" min="5" max="100" step="0.5"></label><label>Höhe (mm)<input type="number" name="logoHeightMm" min="5" max="60" step="0.5"></label><label data-pl-reserved>Textabstand (mm)<input type="number" name="logoSpacingMm" min="0" max="10" step="0.5"></label></div><p class="spl-hint" data-pl="branding-status">Verfügbare Branding-Kits werden geladen.</p></details></section>
        <details class="spl-card spl-paper" open><summary>Papier & Druck</summary><div class="spl-fields"><label>Papier<select name="paper"><option value="A4">A4</option><option value="A5">A5</option><option value="A6">A6</option><option value="custom">Eigene Maße</option></select></label><label>Papierausrichtung<select name="orientation"><option value="portrait">Hochformat</option><option value="landscape">Querformat</option></select></label>
          <label data-pl-custom>Papierbreite (mm)<input type="number" name="paperWidthMm" min="10" max="500" step="0.5" required></label><label data-pl-custom>Papierhöhe (mm)<input type="number" name="paperHeightMm" min="10" max="500" step="0.5" required></label>
          <label>Rand (mm)<input type="number" name="marginMm" min="0" max="50" step="0.5" required></label><label>Abstand (mm)<input type="number" name="gapMm" min="0" max="50" step="0.5" required></label><label>Kopien je Artikel<input type="number" name="copies" min="1" max="50" step="1" required></label></div><div class="spl-checks"><label class="spl-wide"><input name="cutMarks" type="checkbox"> Umrandungsschnittmarken</label></div><p class="spl-hint" data-pl="cut-hint"></p><p class="spl-hint spl-fit-hint" data-pl="paper-fit-hint" role="status" aria-live="polite" hidden></p><button type="button" data-pl="paper-fit" hidden>Papier passend einstellen</button>
          <section class="spl-paper-layout" aria-label="Papierseiten-Belegung"><header><strong>Seitenbelegung</strong><span>Schilderanordnung</span></header><div class="spl-paper-navigation"><button type="button" data-pl="paper-prev" aria-label="Vorherige Papierseite">‹</button><label>Seite<input type="number" data-pl="paper-page-number" min="1" step="1" value="1" aria-label="Papierseite wählen"></label><span data-pl="paper-page-count"></span><button type="button" data-pl="paper-next" aria-label="Nächste Papierseite">›</button></div><div class="spl-paper-stage" data-pl="paper-preview"></div><p class="spl-hint" data-pl="paper-occupancy" role="status" aria-live="polite"></p><p class="spl-hint">Nummern zeigen die Druckreihenfolge. Grün: belegt · Hell: frei.</p></section><p class="spl-hint">PDF ohne Druckskalierung bei 100 % ausdrucken.</p></details>
      </form><div class="spl-output"><section class="spl-card spl-preview-card"><header><div><h2>Vorschau</h2><p data-pl="dimensions"></p></div><span class="spl-preview-badge">Preisschild</span></header><label class="spl-preview-font">Schriftart direkt wählen<select data-pl="preview-font" aria-label="Schriftart in der Schildvorschau">${Fonts.families.map(font => '<option value="' + font.id + '">' + font.label + '</option>').join('')}</select></label><label class="spl-picker" data-pl="picker-label">Artikel in der Vorschau<select data-pl="picker" aria-label="Artikel in der Vorschau"><option>Artikel laden</option></select></label><div class="spl-preview-stage" data-pl="stage"><div data-pl="preview"></div></div><p class="spl-hint spl-logo-editor-hint" data-pl="logo-editor-hint" hidden>Logo auswählen und ziehen; der Griff rechts unten ändert die Größe. Pfeiltasten verschieben, am Griff ändern sie die Größe (Umschalt: 5 mm). Freie Anordnung kann Text und Preis überdecken.</p><p class="spl-logo-live" data-pl="logo-live" role="status" aria-live="polite"></p><p class="spl-layout-info" data-pl="layout"></p><p class="spl-hint" data-pl="updated">Noch keine Artikel geladen.</p></section>
        <section class="spl-card spl-export"><h2>PDF exportieren</h2><form data-pl="export"><label>Dateiname<input name="name" maxlength="110" value="Preisschilder" required></label><div class="spl-fields"><label>Zeitblock<select name="stamp"><option value="date-time">JJMMTT-HHMM</option><option value="date">JJMMTT</option><option value="date-suffix">JJMMTT-xxx</option><option value="none">Ohne Zeitblock</option></select></label><label>Anordnung<select name="position"><option value="before">Vorne</option><option value="after">Hinten</option></select></label><label>Ergänzung (xxx)<input name="suffix" maxlength="40" placeholder="z. B. Aktion"></label><label>Trennzeichen<select name="separator"><option value="-">Bindestrich (-)</option><option value="_">Unterstrich (_)</option><option value=" ">Leerzeichen</option></select></label></div><p class="spl-filename" data-pl="filename"></p><button type="submit" class="spl-primary" data-pl="download" disabled>PDF herunterladen</button></form><p class="spl-status" data-pl="status" role="status" aria-live="polite">Artikelnummern eingeben und die aktuellen Preise laden.</p></section>
      </div></div>`;
    const q = key => root.querySelector('[data-pl="' + key + '"]'), form = q('settings'), exportForm = q('export');
    let active = false, owner = '', generation = 0, items = [], updatedAt = null, loadedKey = '', busy = false, saving = false, timer = null, articleReloadPending = false;
    let logoSelected = false, logoDrag = null, lastRenderedOptions = null, paperPage = 0;
    let brandingKits = [], brandingLoaded = false, brandingMessage = '', library = { templates: [], ownBranch: null, recipients: [], capabilities: { create: false, ownBranch: false } },
      libraryMode = 'defaults', selectedTemplate = null, libraryLoading = false, libraryReady = false,
      personalDefaults = { options: { ...defaults }, filenameOptions: { ...fileDefaults } };
    const controllers = new Set(), listeners = [];
    const permitted = ticket => active && root.isConnected && accessKey() === owner && (ticket === undefined || ticket === generation);
    const on = (node, type, handler) => { node.addEventListener(type, handler); listeners.push(() => node.removeEventListener(type, handler)); };
    const request = async (url, body, method = 'POST') => {
      const controller = new AbortController(); controllers.add(controller);
      try { return await api(url, { signal: controller.signal, ...(body === undefined ? {} : { method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }) }); }
      finally { controllers.delete(controller); }
    };
    const numbers = () => parseArticleNumbers(form.elements.articleNumbers.value);
    const key = () => JSON.stringify([numbers(), form.elements.priceType.value]);
    function rawOptions() {
      const value = {};
      for (const [field, fallback] of Object.entries(defaults)) {
        const input = form.elements[field]; value[field] = typeof fallback === 'boolean' ? input.checked : typeof fallback === 'number' ? input.value === '' ? NaN : Number(input.value) : input.value;
      }
      return value;
    }
    const options = () => normalizeOptions(rawOptions());
    const fileOptions = () => Object.fromEntries(Object.keys(fileDefaults).map(field => [field, exportForm.elements[field].value]));
    const readOnlyTemplate = () => libraryMode === 'template' && selectedTemplate?.canEdit !== true;
    const branchTemplateLocked = () => libraryMode === 'template' && selectedTemplate?.received === true && selectedTemplate?.canEdit === true;
    const createOption = (value, label, disabled = false) => {
      const option = root.ownerDocument.createElement('option'); option.value = value; option.textContent = label; option.disabled = disabled; return option;
    };
    function fillLogoChoices(kitId = '', assetKey = '') {
      const kitSelect = form.elements.logoKitId, assetSelect = form.elements.logoAssetKey;
      const kit = brandingKits.find(item => item.id === kitId);
      kitSelect.replaceChildren(createOption('', 'Ohne Logo'), ...brandingKits.map(item => createOption(item.id, item.name)));
      if (kitId && !kit) kitSelect.append(createOption(kitId, 'Gespeichertes Branding-Kit nicht verfügbar'));
      kitSelect.value = kitId;
      assetSelect.replaceChildren(createOption('', 'Logo auswählen'), ...(kit?.logos || []).map(item => createOption(item.key, item.label)));
      if (assetKey && !kit?.logos?.some(item => item.key === assetKey)) assetSelect.append(createOption(assetKey, 'Gespeichertes Logo nicht verfügbar'));
      assetSelect.value = assetKey;
    }
    function setOptions(value) {
      const saved = normalizeOptions(value);
      fillLogoChoices(saved.logoKitId, saved.logoAssetKey);
      for (const [field, value] of Object.entries(saved)) { const input = form.elements[field]; if (typeof value === 'boolean') input.checked = value; else input.value = value; }
      q('color-text').value = saved.color.toUpperCase();
    }
    function setFileOptions(value) {
      for (const field of Object.keys(fileDefaults)) exportForm.elements[field].value = typeof value?.[field] === 'string' ? value[field] : fileDefaults[field];
    }
    const status = (text, warning = false) => { q('status').textContent = text; q('status').classList.toggle('is-warning', warning); };
    function brandingUrl(value) {
      if (typeof value !== 'string' || !value || !globalThis.location?.origin) return '';
      try { const url = new URL(value, globalThis.location.origin); return url.origin === globalThis.location.origin && ['https:', 'http:'].includes(url.protocol) && !url.username && !url.password ? url.href : ''; }
      catch { return ''; }
    }
    function selectedLogo(value) {
      const kit = brandingKits.find(item => item.id === value.logoKitId), logo = kit?.logos?.find(item => item.key === value.logoAssetKey);
      return logo && brandingUrl(logo.url) ? { ...logo, url: brandingUrl(logo.url), kitName: kit.name } : null;
    }
    const recipientIds = () => [...q('library-recipients').querySelectorAll('input:checked')].map(input => input.value);
    function renderRecipients(ids = []) {
      const selected = new Set(ids);
      q('library-recipients').replaceChildren(...library.recipients.map(recipient => {
        const label = root.ownerDocument.createElement('label'), input = root.ownerDocument.createElement('input'), text = root.ownerDocument.createElement('span');
        input.type = 'checkbox'; input.value = recipient.id; input.checked = selected.has(recipient.id);
        text.textContent = recipient.label; const location = root.ownerDocument.createElement('small'); location.textContent = recipient.locationLabel || '';
        text.append(location); label.append(input, text); return label;
      }));
      if (!library.recipients.length) { const empty = root.ownerDocument.createElement('p'); empty.className = 'spl-hint'; empty.textContent = 'Derzeit sind keine weiteren freigegebenen Filialkonten verfügbar.'; q('library-recipients').append(empty); }
    }
    function renderLibrary(printable = true) {
      const readonly = readOnlyTemplate(), branchLocked = branchTemplateLocked(), scope = q('library-scope'), canCreate = library.capabilities.create === true;
      q('library-editor').hidden = libraryMode === 'defaults';
      q('library-title').disabled = readonly || saving || libraryLoading;
      scope.querySelector('[value="branch"]').disabled = !library.ownBranch || library.capabilities.ownBranch !== true;
      scope.querySelector('[value="branch"]').textContent = library.ownBranch ? 'Eigene Filiale · ' + library.ownBranch.label : 'Eigene Filiale';
      for (const value of ['private', 'selected']) scope.querySelector('[value="' + value + '"]').disabled = branchLocked;
      scope.disabled = readonly || branchLocked || saving || libraryLoading;
      q('library-select').disabled = saving || libraryLoading;
      q('library-new').disabled = !permitted() || !libraryReady || !canCreate || saving || libraryLoading;
      q('library-copy').disabled = !permitted() || !libraryReady || !canCreate || libraryMode !== 'template' || saving || libraryLoading;
      q('library-recipients-panel').hidden = libraryMode === 'defaults' || scope.value !== 'selected';
      q('library-recipients').querySelectorAll('input').forEach(input => { input.disabled = readonly || saving || libraryLoading; });
      const count = recipientIds().length; q('library-recipient-count').textContent = count ? '· ' + count + ' ausgewählt' : '';
      q('library-summary').textContent = libraryReady ? library.templates.length + ' gespeicherte Vorlage' + (library.templates.length === 1 ? '' : 'n') : libraryLoading ? 'Wird geladen …' : '';
      q('save').textContent = libraryMode === 'defaults' ? 'Standardeinstellung speichern' : libraryMode === 'new' ? 'Neue Vorlage speichern' : 'Änderungen speichern';
      q('save').disabled = !permitted() || busy || saving || libraryLoading || readonly || !printable || libraryMode === 'new' && !canCreate;
      const hint = readonly ? 'Freigegebene Vorlage von ' + (selectedTemplate?.creator?.label || 'einem anderen Konto') + '. Für eigene Änderungen eine Kopie anlegen.'
        : branchLocked ? 'Filialvorlage · Änderungen gelten für die eigene Filiale. Mit einer Kopie kannst du eine eigene Vorlage anlegen.'
          : scope.value === 'branch' ? 'Diese Vorlage steht den berechtigten Konten der eigenen Filiale zur Verfügung.'
            : scope.value === 'selected' ? 'Ausgewählte Filialkonten können die Vorlage verwenden und als eigene Kopie speichern. Empfänger kannst du später ändern.'
              : 'Diese Vorlage ist nur für dein Konto sichtbar.';
      q('library-hint').textContent = hint + (selectedTemplate?.unavailableRecipientCount ? ' Frühere Empfänger sind nicht mehr verfügbar; beim Speichern werden diese Freigaben entfernt.' : '');
      for (const field of Object.keys(defaults)) form.elements[field].disabled = readonly;
      for (const field of Object.keys(fileDefaults)) exportForm.elements[field].disabled = readonly;
      q('color-text').disabled = readonly;
      q('preview-font').disabled = readonly;
      exportForm.elements.suffix.disabled = readonly || exportForm.elements.stamp.value !== 'date-suffix';
      root.querySelectorAll('[data-pl-preset]').forEach(button => { button.disabled = readonly || saving || libraryLoading || !permitted(); });
      q('label-orientation').disabled = readonly || saving || libraryLoading || !permitted();
      q('paper-fit').disabled = readonly || busy || saving || libraryLoading || !permitted();
      form.elements.cutMarks.disabled = readonly || form.elements.showBorder.checked;
      form.elements.logoAssetKey.disabled = readonly || !form.elements.logoKitId.value;
      for (const field of ['logoMode', 'logoPosition', 'logoWidthMm', 'logoHeightMm', 'logoSpacingMm', 'logoXmm', 'logoYmm']) form.elements[field].disabled = readonly || !form.elements.logoKitId.value;
    }
    function fillLibrarySelect() {
      q('library-select').replaceChildren(createOption('', 'Persönliche Standardeinstellung'), ...(libraryMode === 'new' ? [createOption('__new', 'Neue Vorlage · Entwurf')] : []), ...library.templates.map(template => createOption(template.id,
        template.title + (template.received ? template.visibility === 'branch' ? ' · Filialvorlage' : ' · Freigegeben' : ''))));
      q('library-select').value = libraryMode === 'template' ? selectedTemplate?.id || '' : libraryMode === 'new' ? '__new' : '';
    }
    function chooseTemplate(id) {
      const template = library.templates.find(item => item.id === id);
      if (!id) {
        libraryMode = 'defaults'; selectedTemplate = null; setOptions(personalDefaults.options); setFileOptions(personalDefaults.filenameOptions);
        q('library-title').value = ''; q('library-scope').value = 'private'; renderRecipients();
      } else if (template) {
        setOptions(template.options); setFileOptions(template.filenameOptions); libraryMode = 'template'; selectedTemplate = template;
        q('library-title').value = template.title; q('library-scope').value = template.visibility; renderRecipients(template.recipients);
      }
      q('saved').textContent = ''; q('library-reload').hidden = true; render();
    }
    async function loadLibrary(ticket = generation) {
      const result = await request('/api/sales/price-labels/library');
      if (!permitted(ticket)) return false;
      library = { templates: Array.isArray(result.templates) ? result.templates : [], ownBranch: result.ownBranch || null,
        recipients: Array.isArray(result.recipients) ? result.recipients : [], capabilities: result.capabilities || {} };
      libraryReady = true; fillLibrarySelect(); renderRecipients(recipientIds()); render(); return true;
    }
    function imageUrl(value) {
      if (typeof value !== 'string' || !value || !globalThis.location?.origin) return '';
      try { const url = new URL(value, globalThis.location.origin); return url.origin === globalThis.location.origin && ['https:', 'http:'].includes(url.protocol) && url.pathname === '/api/sales/price-labels/image' ? url.href : ''; }
      catch { return ''; }
    }
    function render() {
      let value, valid = true;
      try { value = options(); } catch (error) { value = { ...defaults }; valid = false; q('layout').textContent = error.message; }
      root.querySelectorAll('[data-pl-custom]').forEach(node => { node.hidden = value.paper !== 'custom'; });
      try { q('count').textContent = numbers().length + ' / 100'; } catch { q('count').textContent = 'Bitte Auswahl prüfen'; }
      let current = false, placementCurrent = false;
      try { placementCurrent = Boolean(loadedKey && loadedKey === key()); current = placementCurrent && !busy; } catch { /* Invalid input has no trusted current preview. */ }
      const layout = PaperGrid.create(value,placementCurrent ? items.length : 0), circle = value.shape === 'circle', diameter = Math.min(value.labelWidthMm, value.labelHeightMm);
      const format = labelFormat(value); q('label-orientation').value = format.orientation;
      root.querySelectorAll('[data-pl-preset]').forEach(button => button.setAttribute('aria-pressed',String(valid && button.dataset.plPreset === format.id)));
      const adjustment = valid ? paperAdjustment(value) : null;
      q('paper-fit-hint').hidden = !adjustment; q('paper-fit').hidden = !adjustment;
      if (adjustment) {
        const proposed = paperLayout({...value,...adjustment}), direction = adjustment.orientation === 'portrait' ? 'Hochformat' : 'Querformat';
        q('paper-fit-hint').textContent = 'Das Schild (' + value.labelWidthMm + ' × ' + value.labelHeightMm + ' mm) passt nicht auf ' + layout.width + ' × ' + layout.height + ' mm Papier mit ' + value.marginMm + ' mm Rand. Papier und Rand kannst du passend übernehmen; die Schildgröße bleibt erhalten.';
        q('paper-fit').textContent = (adjustment.paper === 'custom' ? proposed.width + ' × ' + proposed.height + ' mm' : adjustment.paper) + ' ' + direction + ', Rand ' + adjustment.marginMm + ' mm übernehmen';
      }
      q('dimensions').textContent = circle ? 'Kreis Ø ' + diameter + ' mm · Schildfläche ' + value.labelWidthMm + ' × ' + value.labelHeightMm + ' mm' : value.labelWidthMm + ' × ' + value.labelHeightMm + ' mm';
      const {labelCount,pageCount,exceedsLimits:exceedsLimit} = layout;
      if (valid) q('layout').textContent = !layout.capacity ? 'Das Schild passt mit diesen Rändern nicht auf das gewählte Papier. Bitte Maße oder Rand ändern.' : exceedsLimit ? 'Bitte höchstens 1000 Schilder und 200 PDF-Seiten wählen. Kopienzahl oder Artikelauswahl verringern.' : layout.columns + ' × ' + layout.rows + (layout.capacity === 1 ? ' Schild pro Seite · ' : ' Schilder pro Seite · ') + layout.capacity + (layout.capacity === 1 ? ' Platz auf ' : ' Plätze auf ') + (value.paper === 'custom' ? layout.width + ' × ' + layout.height + ' mm' : value.paper) + (labelCount ? ' · ' + labelCount + (labelCount === 1 ? ' Schild · ' : ' Schilder · ') + pageCount + ' PDF-Seite' + (pageCount !== 1 ? 'n' : '') : '');
      q('layout').classList.toggle('is-warning', !valid || !layout.capacity || exceedsLimit);
      paperPage = Math.max(0,Math.min(paperPage,Math.min(PaperGrid.MAX_PAGES,pageCount)-1));
      q('paper-page-number').value = String(paperPage+1); q('paper-page-number').max = String(Math.max(1,Math.min(PaperGrid.MAX_PAGES,pageCount)));
      q('paper-page-number').disabled = !permitted() || !valid || !layout.capacity || !pageCount;
      q('paper-prev').disabled = !permitted() || !valid || paperPage < 1;
      q('paper-next').disabled = !permitted() || !valid || paperPage+1 >= Math.min(PaperGrid.MAX_PAGES,pageCount);
      q('paper-page-count').textContent = pageCount ? 'von ' + pageCount : 'von 0';
      q('paper-preview').innerHTML = valid && layout.capacity ? pagePreview(value,layout,paperPage,items) : '';
      const occupied = layout.page(paperPage).filter(cell=>cell.occupied).length;
      q('paper-occupancy').textContent = !valid ? 'Bitte die Druckeinstellungen prüfen.' : !layout.capacity ? 'Für diese Maße ist kein Schildplatz verfügbar.' : !labelCount ? 'Noch keine aktuellen Artikel geladen · ' + layout.capacity + (layout.capacity === 1 ? ' freier Platz.' : ' freie Plätze.') : 'Seite ' + (paperPage+1) + ': ' + occupied + ' belegt · ' + (layout.capacity-occupied) + ' frei · Schilder ' + (paperPage*layout.capacity+1) + '–' + (paperPage*layout.capacity+occupied);
      q('cut-hint').textContent = value.showBorder ? 'Schnittmarken sind bei eingeschalteter Schildumrandung inaktiv.' : value.cutMarks ? 'Dünne gestrichelte Linien folgen der Schildform und bleiben innerhalb der Schildkante.' : 'Optional für randlose Schilder: gestrichelte Linien entlang der Schildform.';
      const article = current ? items.find(item => item.articleNumber === q('picker').value) || items[0] : null;
      const shownPrice = article ? price(article.priceGross) : null, photo = value.showPhoto ? imageUrl(article?.imageUrl) : '';
      const logo = selectedLogo(value), logoUnavailable = Boolean(value.logoKitId && !logo);
      const freeLogo = value.logoMode === 'free', editableLogo = valid && permitted() && !readOnlyTemplate();
      form.elements.logoWidthMm.max = freeLogo ? '500' : '100'; form.elements.logoHeightMm.max = freeLogo ? '500' : '60';
      root.querySelectorAll('[data-pl-free]').forEach(node => { node.hidden = !freeLogo; });
      root.querySelectorAll('[data-pl-reserved]').forEach(node => { node.hidden = freeLogo; });
      q('preview-font').value = value.fontId;
      q('logo-editor-hint').hidden = !logo || !editableLogo;
      q('logo-summary').textContent = logo ? logo.label : value.logoKitId ? 'Nicht verfügbar' : 'Ohne Logo';
      if (brandingLoaded) q('branding-status').textContent = logoUnavailable ? 'Das gespeicherte Logo ist nicht verfügbar. Bitte ein anderes wählen oder ohne Logo fortfahren.'
        : brandingMessage || (brandingKits.length ? 'Das Logo behält seine Proportionen innerhalb der gewählten Größe.' : 'Derzeit sind keine freigegebenen Logos verfügbar.');
      const color = value.color, contrast = (parseInt(color.slice(1, 3), 16) * 299 + parseInt(color.slice(3, 5), 16) * 587 + parseInt(color.slice(5), 16) * 114) / 1000 > 155 ? '#172331' : '#ffffff';
      const label = root.ownerDocument.createElement('article'); label.className = 'spl-label spl-design-' + value.design + ' spl-shape-' + value.shape + (freeLogo ? ' spl-logo-free' : '') + (value.showBorder ? ' spl-border-on' : ' spl-border-off');
      label.style.setProperty('font-family', '"' + Fonts.get(value.fontId).cssFamily + '"');
      label.style.setProperty('font-synthesis', 'none');
      label.style.setProperty('--spl-accent', color); label.style.setProperty('--spl-contrast', contrast);
      label.style.setProperty('--spl-aspect', circle && !freeLogo ? '1' : String(value.labelWidthMm / value.labelHeightMm));
      label.style.setProperty('--spl-circle-width', (diameter / value.labelWidthMm * 100) + '%');
      label.style.setProperty('--spl-circle-height', (diameter / value.labelHeightMm * 100) + '%');
      label.style.setProperty('--spl-price-size', Math.max(7, Math.min(18, 100 / Math.max(6, (shownPrice || '').length))) + 'cqi');
      label.style.setProperty('--spl-logo-width', (value.logoWidthMm / value.labelWidthMm * 100) + 'cqi');
      label.style.setProperty('--spl-logo-height', (value.logoHeightMm / value.labelWidthMm * 100) + 'cqi');
      label.style.setProperty('--spl-logo-spacing', (value.logoSpacingMm / value.labelWidthMm * 100) + 'cqi');
      const logoStyle = freeLogo ? ' style="left:' + (value.logoXmm / value.labelWidthMm * 100) + '%;top:' + (value.logoYmm / value.labelHeightMm * 100) + '%;width:' + (value.logoWidthMm / value.labelWidthMm * 100) + '%;height:' + (value.logoHeightMm / value.labelHeightMm * 100) + '%"' : '';
      const logoEditor = logo ? '<div data-pl-logo class="spl-logo-editor' + (freeLogo ? ' spl-logo-overlay' : '') + (editableLogo ? ' spl-logo-editable' : '') + (logoSelected ? ' is-selected' : '') + '" role="group" tabindex="' + (editableLogo ? '0' : '-1') + '" aria-label="Logo ' + escape(logo.label) + (editableLogo ? ' verschieben. Pfeiltasten oder ziehen.' : '') + '"' + logoStyle + '><img class="spl-label-logo" draggable="false" alt="' + escape(logo.label) + '" src="' + escape(logo.url) + '">' + (editableLogo ? '<button type="button" class="spl-logo-resize" data-pl-logo-resize aria-label="Logo am Griff vergrößern oder verkleinern. Pfeiltasten ändern Breite und Höhe."></button>' : '') + '</div>' : '';
      const logoRow = !freeLogo && logo ? '<div class="spl-label-logo-row spl-logo-' + escape(value.logoPosition.split('-')[1]) + '">' + logoEditor + '</div>' : '';
      label.innerHTML = (value.logoPosition.startsWith('top-') ? logoRow : '') + (value.headline ? '<div class="spl-label-headline">' + escape(value.headline) + '</div>' : '') +
        '<div class="spl-label-product">' + (article?.brand ? '<small class="spl-brand">' + escape(article.brand) + '</small>' : '') + '<h3>' + escape(article?.description || 'Artikel auswählen und aktuellen Preis laden') + '</h3></div>' +
        (photo ? '<img class="spl-label-photo" alt="' + escape(article?.description || 'Artikelfoto') + '" src="' + escape(photo) + '">' : '') +
        '<div class="spl-label-price' + (shownPrice === null ? ' spl-price-missing' : '') + '"><strong>' + escape(shownPrice === null ? 'Preis prüfen' : shownPrice) + '</strong>' + (shownPrice === null ? '' : '<span>€</span>') + '</div>' +
        '<div class="spl-label-meta">' + (value.showArticleNumber ? '<span>Art. ' + escape(article?.articleNumber || '-') + '</span>' : '') +
        (value.showEan ? '<span>EAN ' + escape(article?.ean || '- nicht hinterlegt') + '</span>' : '') +
        (value.showTax ? '<span>' + (article?.taxRate !== null && article?.taxRate !== undefined && /^\d+(?:\.\d+)?$/.test(String(article.taxRate)) ? 'inkl. ' + escape(String(article.taxRate).replace('.', ',')) + ' % MwSt.' : 'MwSt. prüfen') + '</span>' : '') + '</div>' +
        (value.footer ? '<p class="spl-label-footer">' + escape(value.footer) + '</p>' : '') + (value.logoPosition.startsWith('bottom-') ? logoRow : '') + (freeLogo ? logoEditor : '');
      q('preview').replaceChildren(label);
      lastRenderedOptions = value;
      label.querySelectorAll('img').forEach(image => image.addEventListener('error', event => { event.target.remove(); }, { once: true }));
      q('picker-label').hidden = items.length < 2;
      q('download').disabled = !permitted() || busy || !current || !valid || !layout.capacity || exceedsLimit || logoUnavailable || !items.length || items.some(item => price(item.priceGross) === null);
      q('refresh').disabled = busy;
      exportForm.elements.suffix.disabled = exportForm.elements.stamp.value !== 'date-suffix';
      q('filename').textContent = filename(exportForm.elements.name.value, fileOptions());
      renderLibrary(valid && layout.capacity > 0);
    }
    function finishBusy(ticket) {
      if (!permitted(ticket)) return;
      busy = false; render();
      if (articleReloadPending) void loadArticles();
    }
    async function loadArticles() {
      if (!permitted()) return;
      if (busy) { articleReloadPending = true; return; }
      articleReloadPending = false; clearTimeout(timer); timer = null;
      let articleNumbers; try { articleNumbers = numbers(); if (!articleNumbers.length) throw new Error('Bitte mindestens eine Artikelnummer eingeben.'); }
      catch (error) { status(error.message, true); return; }
      const ticket = generation, signature = key(), priceType = form.elements.priceType.value;
      const selectionCurrent = () => { try { return signature === key(); } catch { return false; } };
      busy = true; status('Aktuelle Artikelpreise werden geladen …'); render();
      try {
        const result = await request('/api/sales/price-labels/articles', { articleNumbers, priceType });
        if (!permitted(ticket) || !selectionCurrent()) return;
        const found = new Map((Array.isArray(result.items) ? result.items : []).filter(item => articleNumbers.includes(item.articleNumber)).map(item => [item.articleNumber, item]));
        items = articleNumbers.map(articleNumber => found.get(articleNumber) || { articleNumber, description: 'Artikel nicht gefunden', priceGross: null });
        loadedKey = signature; updatedAt = result.updatedAt;
        q('picker').replaceChildren(...items.map(item => { const option = root.ownerDocument.createElement('option'); option.value = item.articleNumber; option.textContent = item.articleNumber + ' · ' + item.description; return option; }));
        const missing = items.filter(item => price(item.priceGross) === null).length;
        status(missing ? missing + ' Artikel ohne bestätigten Bruttopreis. Bitte Preisart oder Artikelauswahl prüfen.' : items.length + ' Artikel mit aktuellen Bruttopreisen geladen.', Boolean(missing));
        const timestamp = updatedAt && Number.isFinite(Date.parse(updatedAt)) ? new Intl.DateTimeFormat('de-AT', { timeZone: 'Europe/Vienna', dateStyle: 'short', timeStyle: 'short' }).format(new Date(updatedAt)) : '';
        q('updated').textContent = (timestamp ? 'Preise geladen: ' + timestamp + ' · ' : '') + (result.note || 'Der PDF-Export liest die aktuellen freigegebenen Artikelpreise erneut.');
      } catch (error) { if (permitted(ticket) && selectionCurrent() && error.name !== 'AbortError') { items = []; loadedKey = ''; status(error.message, true); } }
      finally { finishBusy(ticket); }
    }
    on(form, 'submit', event => { event.preventDefault(); void loadArticles(); });
    on(q('refresh'), 'click', () => { void loadArticles(); });
    function logoGeometry(value) {
      if (value.logoMode === 'free') return { x: value.logoXmm, y: value.logoYmm, width: value.logoWidthMm, height: value.logoHeightMm };
      const editor = q('preview').querySelector('[data-pl-logo]'), label = q('preview').querySelector('.spl-label');
      if (editor?.getBoundingClientRect && label?.getBoundingClientRect) {
        const box = editor.getBoundingClientRect(), frame = logoFrame(label);
        if (frame.width > 0 && frame.height > 0) return { x: (box.left - frame.left) / frame.width * value.labelWidthMm,
          y: (box.top - frame.top) / frame.height * value.labelHeightMm, width: value.logoWidthMm, height: value.logoHeightMm };
      }
      return { x: 4, y: 4, width: value.logoWidthMm, height: value.logoHeightMm };
    }
    function writeLogo(value, geometry, focus = '') {
      const changed = boundedLogo(value, geometry);
      for (const [field, next] of Object.entries(changed)) form.elements[field].value = next;
      logoSelected = true; q('saved').textContent = ''; render();
      q('logo-live').textContent = 'Logo: X ' + changed.logoXmm + ', Y ' + changed.logoYmm + ' mm · ' + changed.logoWidthMm + ' × ' + changed.logoHeightMm + ' mm.';
      if (focus) q('preview').querySelector(focus)?.focus?.({ preventScroll: true });
    }
    const canEditLogo = () => permitted() && !readOnlyTemplate() && !saving && Boolean(form.elements.logoKitId.value);
    function finishLogoDrag(event, cancel = false) {
      const drag = logoDrag;
      if (!drag || event && event.pointerId !== undefined && event.pointerId !== drag.pointerId) return;
      logoDrag = null;
      try { if (q('preview').hasPointerCapture?.(drag.pointerId)) q('preview').releasePointerCapture(drag.pointerId); } catch { /* Navigation can already have released capture. */ }
      if (!permitted(drag.ticket)) return;
      if (cancel) {
        for (const field of ['logoMode', 'logoXmm', 'logoYmm', 'logoWidthMm', 'logoHeightMm']) form.elements[field].value = drag.options[field];
        render(); q('logo-live').textContent = 'Logoänderung verworfen.';
      }
      q('preview').querySelector(drag.resize ? '[data-pl-logo-resize]' : '[data-pl-logo]')?.focus?.({ preventScroll: true });
    }
    on(q('preview'), 'pointerdown', event => {
      const editor = event.target.closest?.('[data-pl-logo]');
      if (!editor || logoDrag || event.isPrimary === false || !canEditLogo() || event.button !== undefined && event.button !== 0) return;
      let value; try { value = options(); } catch { return; }
      const label = editor.closest('.spl-label'), frame = logoFrame(label);
      if (!frame.width || !frame.height) return;
      const geometry = logoGeometry(value), resize = Boolean(event.target.closest('[data-pl-logo-resize]'));
      logoDrag = { options: value, geometry, resize, pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY,
        width: frame.width, height: frame.height, ticket: generation, moved: false };
      event.preventDefault();
      try { q('preview').setPointerCapture?.(event.pointerId); } catch { /* Pointer capture is unavailable in some embedded views. */ }
      // Selecting an anchored logo must not change the saved layout. Only an
      // actual move/resize (or an arrow key) switches to free geometry.
      logoSelected = true; editor.classList.add('is-selected');
      (resize ? event.target.closest('[data-pl-logo-resize]') : editor).focus?.({ preventScroll: true });
    });
    on(q('preview'), 'pointermove', event => {
      const drag = logoDrag; if (!drag || event.pointerId !== drag.pointerId || !permitted(drag.ticket) || !canEditLogo()) return;
      event.preventDefault();
      const currentLabel = q('preview').querySelector('.spl-label');
      const frame = currentLabel?.getBoundingClientRect ? logoFrame(currentLabel) : drag;
      const dx = (event.clientX - drag.clientX) / (frame.width || drag.width) * drag.options.labelWidthMm;
      const dy = (event.clientY - drag.clientY) / (frame.height || drag.height) * drag.options.labelHeightMm;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < .0001) return;
      drag.moved = true;
      const geometry = { ...drag.geometry };
      if (drag.resize) {
        geometry.width = Math.min(drag.options.labelWidthMm - geometry.x, geometry.width + dx);
        geometry.height = Math.min(drag.options.labelHeightMm - geometry.y, geometry.height + dy);
      } else { geometry.x += dx; geometry.y += dy; }
      writeLogo(drag.options, geometry, drag.resize ? '[data-pl-logo-resize]' : '[data-pl-logo]');
    });
    on(q('preview'), 'pointerup', event => finishLogoDrag(event));
    on(q('preview'), 'pointercancel', event => finishLogoDrag(event, true));
    on(q('preview'), 'lostpointercapture', event => finishLogoDrag(event));
    on(q('preview'), 'focusin', event => {
      const editor = event.target.closest?.('[data-pl-logo]'); if (!editor || !canEditLogo()) return;
      logoSelected = true; editor.classList.add('is-selected');
    });
    on(q('preview'), 'keydown', event => {
      if (event.key === 'Escape') { if (logoDrag) { event.preventDefault(); finishLogoDrag(null, true); } return; }
      const editor = event.target.closest?.('[data-pl-logo]');
      if (!editor || !canEditLogo() || !['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      let value; try { value = options(); } catch { return; }
      event.preventDefault(); const geometry = logoGeometry(value), amount = event.shiftKey ? 5 : .5;
      const dx = event.key === 'ArrowRight' ? amount : event.key === 'ArrowLeft' ? -amount : 0;
      const dy = event.key === 'ArrowDown' ? amount : event.key === 'ArrowUp' ? -amount : 0;
      const resize = Boolean(event.target.closest('[data-pl-logo-resize]'));
      if (resize) {
        geometry.width = Math.min(value.labelWidthMm - geometry.x, geometry.width + dx);
        geometry.height = Math.min(value.labelHeightMm - geometry.y, geometry.height + dy);
      } else { geometry.x += dx; geometry.y += dy; }
      writeLogo(value, geometry, resize ? '[data-pl-logo-resize]' : '[data-pl-logo]');
    });
    on(q('preview-font'), 'change', () => {
      if (!permitted() || readOnlyTemplate()) return;
      form.elements.fontId.value = q('preview-font').value; q('saved').textContent = ''; render();
    });
    const borderInput = event => {
      if (event.target === form.elements.showBorder) form.elements.borderMode.value = 'manual';
      if (event.target === form.elements.design && form.elements.borderMode.value === 'design') form.elements.showBorder.checked = form.elements.design.value !== 'minimal';
    };
    on(form, 'input', event => {
      if ([q('label-orientation'),q('paper-page-number')].includes(event.target)) return;
      if (!permitted() || readOnlyTemplate() && ![form.elements.articleNumbers,form.elements.priceType].includes(event.target)) return;
      borderInput(event);
      if (event.target === form.elements.logoMode && event.target.value === 'free' && lastRenderedOptions?.logoMode !== 'free') {
        writeLogo(lastRenderedOptions, logoGeometry(lastRenderedOptions)); return;
      }
      if ([form.elements.labelWidthMm, form.elements.labelHeightMm].includes(event.target) && form.elements.logoMode.value === 'free') {
        const labelWidthMm = Number(form.elements.labelWidthMm.value), labelHeightMm = Number(form.elements.labelHeightMm.value);
        const geometry = { x: Number(form.elements.logoXmm.value), y: Number(form.elements.logoYmm.value), width: Number(form.elements.logoWidthMm.value), height: Number(form.elements.logoHeightMm.value) };
        if ([labelWidthMm, labelHeightMm].every(n => Number.isFinite(n) && n >= 10 && n <= 500) && Object.values(geometry).every(Number.isFinite)) {
          const changed = boundedLogo({ labelWidthMm, labelHeightMm }, geometry);
          for (const [field, next] of Object.entries(changed)) form.elements[field].value = next;
        }
      }
      if (event.target === q('color-text')) { if (/^#[a-f0-9]{6}$/i.test(event.target.value)) form.elements.color.value = event.target.value; }
      else if (event.target === form.elements.color) q('color-text').value = event.target.value.toUpperCase();
      if (event.target === form.elements.articleNumbers) { loadedKey = ''; status('Artikelauswahl geändert. Bitte die aktuellen Preise laden.'); }
      q('saved').textContent = ''; render();
    });
    on(form, 'change', event => {
      if ([q('label-orientation'),q('paper-page-number')].includes(event.target)) return;
      if (!permitted() || readOnlyTemplate() && ![form.elements.articleNumbers,form.elements.priceType].includes(event.target)) return;
      borderInput(event);
      if (event.target === form.elements.logoKitId) {
        const id = form.elements.logoKitId.value, kit = brandingKits.find(item => item.id === id);
        fillLogoChoices(id, kit?.logos?.[0]?.key || '');
      }
      if (event.target === form.elements.priceType) {
        loadedKey = ''; status('Preisart geändert. Aktuelle Artikelpreise werden nachgeladen …');
        clearTimeout(timer); timer = setTimeout(() => { timer = null; void loadArticles(); }, 200);
      }
      q('saved').textContent = ''; render();
    });
    const changePage = value => {
      if (!permitted()) return;
      paperPage = Number.isInteger(value) ? Math.max(0,value) : 0; render();
    };
    on(q('paper-prev'),'click',() => { if (!q('paper-prev').disabled) changePage(paperPage-1); });
    on(q('paper-next'),'click',() => { if (!q('paper-next').disabled) changePage(paperPage+1); });
    on(q('paper-page-number'),'change',() => { if (!q('paper-page-number').disabled) changePage(Number(q('paper-page-number').value)-1); });
    on(q('picker'), 'change', render); on(exportForm, 'input', render); on(exportForm, 'change', render);
    on(q('library-select'), 'change', () => {
      try { chooseTemplate(q('library-select').value); } catch (error) { q('saved').textContent = error.message; }
    });
    const newTemplate = copy => {
      if (!permitted() || !libraryReady || library.capabilities.create !== true || saving) return;
      const title = copy ? (q('library-title').value || selectedTemplate?.title || 'Vorlage') + ' (Kopie)' : 'Neue Vorlage';
      libraryMode = 'new'; selectedTemplate = null; fillLibrarySelect(); q('library-title').value = title.slice(0, 80);
      q('library-scope').value = library.ownBranch && library.capabilities.ownBranch === true ? 'branch' : 'private'; renderRecipients(); q('saved').textContent = ''; q('library-reload').hidden = true;
      render(); q('library-title').focus(); q('library-title').select();
    };
    on(q('library-new'), 'click', () => newTemplate(false)); on(q('library-copy'), 'click', () => newTemplate(true));
    for (const field of ['library-title', 'library-scope', 'library-recipients']) on(q(field), 'change', () => { q('saved').textContent = ''; render(); });
    on(q('library-title'), 'input', () => { q('saved').textContent = ''; });
    on(q('library-reload'), 'click', async () => {
      if (!permitted() || saving || libraryLoading) return; const ticket = generation, id = selectedTemplate?.id;
      libraryLoading = true; render(); q('saved').textContent = 'Vorlagen werden aktualisiert …';
      try { if (await loadLibrary(ticket)) { chooseTemplate(library.templates.some(template => template.id === id) ? id : ''); q('saved').textContent = 'Aktueller Stand geladen.'; } }
      catch (error) { if (permitted(ticket) && error.name !== 'AbortError') q('saved').textContent = error.message; }
      finally { if (permitted(ticket)) { libraryLoading = false; render(); } }
    });
    on(root.querySelector('.spl-presets'), 'click', event => {
      const button = event.target.closest('[data-pl-preset]');
      if (!button || !permitted() || readOnlyTemplate() || saving || libraryLoading) return;
      try { finishLogoDrag(null,true); setOptions(applyLabelFormat(rawOptions(),button.dataset.plPreset)); q('saved').textContent = 'Schildformat gewählt. Papier und Rand bleiben wie eingestellt.'; render(); }
      catch (error) { q('saved').textContent = error.message; }
    });
    on(q('label-orientation'),'change',() => {
      if (!permitted() || readOnlyTemplate() || saving || libraryLoading) return;
      try { const orientation = q('label-orientation').value; finishLogoDrag(null,true);
        setOptions(applyLabelFormat(rawOptions(),'custom',orientation)); q('saved').textContent = 'Schildausrichtung geändert. Papier und Rand bleiben wie eingestellt.'; render(); }
      catch (error) { q('saved').textContent = error.message; }
    });
    on(q('paper-fit'),'click',() => {
      if (!permitted() || readOnlyTemplate() || busy || saving || libraryLoading) return;
      try { const value = options(), adjustment = paperAdjustment(value); if (!adjustment) return;
        setOptions({...value,...adjustment}); q('saved').textContent = 'Papier und Rand passend übernommen. Die Schildgröße bleibt erhalten.'; render(); }
      catch (error) { q('saved').textContent = error.message; }
    });
    on(q('save'), 'click', async () => {
      if (!permitted() || busy || saving || readOnlyTemplate() || libraryLoading) return; const ticket = generation;
      try {
        const body = { options: options(), filenameOptions: fileOptions() }, mode = libraryMode;
        if (!paperLayout(body.options).capacity) throw new Error('Das Schild passt noch nicht auf das Papier. Bitte Papier oder Rand passend einstellen.');
        if (mode !== 'defaults') {
          const title = q('library-title').value.trim(), visibility = q('library-scope').value, recipients = visibility === 'selected' ? recipientIds() : [];
          if (!title || title.length > 80) throw new Error('Bitte einen Titel mit höchstens 80 Zeichen eingeben.');
          if (visibility === 'selected' && (!recipients.length || recipients.length > 50)) throw new Error('Bitte 1 bis 50 Filialkonten auswählen.');
          if (visibility === 'branch' && (!library.ownBranch || library.capabilities.ownBranch !== true)) throw new Error('Für dein Konto ist derzeit keine eigene Filiale verfügbar.');
          Object.assign(body, { title, visibility, recipients });
          if (mode === 'template') body.version = selectedTemplate.version;
        }
        const signature = JSON.stringify({ options: body.options, filenameOptions: body.filenameOptions, title: q('library-title').value, visibility: q('library-scope').value, recipients: recipientIds() });
        saving = true; render(); q('saved').textContent = 'Wird gespeichert …';
        const result = await request(mode === 'defaults' ? '/api/sales/price-labels/templates' : mode === 'new' ? '/api/sales/price-labels/library' : '/api/sales/price-labels/library/' + encodeURIComponent(selectedTemplate.id), body, mode === 'template' ? 'PATCH' : 'POST');
        if (permitted(ticket)) {
          let unchanged = false; try { unchanged = signature === JSON.stringify({ options: options(), filenameOptions: fileOptions(), title: q('library-title').value, visibility: q('library-scope').value, recipients: recipientIds() }); } catch { /* Later edits still need saving. */ }
          if (mode === 'defaults') personalDefaults = result;
          else {
            selectedTemplate = result; libraryMode = 'template'; library.templates = [...library.templates.filter(template => template.id !== result.id), result]; fillLibrarySelect();
            if (unchanged) { setOptions(result.options); setFileOptions(result.filenameOptions); q('library-title').value = result.title; q('library-scope').value = result.visibility; renderRecipients(result.recipients); }
          }
          q('library-reload').hidden = true;
          q('saved').textContent = unchanged ? mode === 'defaults' ? 'Standardeinstellung für dein Konto gespeichert.' : 'Vorlage gespeichert.' : 'Vorlage gespeichert. Deine späteren Änderungen sind noch nicht gespeichert.';
        }
      }
      catch (error) { if (permitted(ticket) && error.name !== 'AbortError') {
        q('saved').textContent = error.status === 409 ? 'Die Vorlage wurde inzwischen geändert. Dein Entwurf bleibt erhalten. Lade den aktuellen Stand oder lege eine Kopie an.' : error.message;
        q('library-reload').hidden = error.status !== 409;
      } }
      finally { if (permitted(ticket)) { saving = false; render(); } }
    });
    on(exportForm, 'submit', async event => {
      event.preventDefault(); if (!permitted() || busy || q('download').disabled) return;
      const ticket = generation, controller = new AbortController(); controllers.add(controller); busy = true; render(); status('Preisschilder werden mit den aktuellen Artikelpreisen erstellt …');
      try {
        const body = { articleNumbers: numbers(), priceType: form.elements.priceType.value, options: options(), name: exportForm.elements.name.value, ...fileOptions() };
        const response = await rawApi('/api/sales/price-labels/export.pdf', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: controller.signal });
        if (!permitted(ticket)) return; const blob = await response.blob(); if (!permitted(ticket)) return;
        const href = URL.createObjectURL(blob), link = root.ownerDocument.createElement('a'); link.href = href; link.download = filename(body.name, Object.fromEntries(Object.keys(fileDefaults).map(field => [field, body[field]]))); root.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(href), 60000);
        status('PDF-Download gestartet. Beim Drucken 100 % beziehungsweise „Tatsächliche Größe“ wählen.');
      } catch (error) { if (permitted(ticket) && error.name !== 'AbortError') status(error.message, true); }
      finally { controllers.delete(controller); finishBusy(ticket); }
    });
    setOptions(defaults); setFileOptions(fileDefaults); render();
    function suspend() {
      finishLogoDrag(null); logoSelected = false; logoDrag = null; q('logo-live').textContent = '';
      active = false; generation++; clearTimeout(timer); timer = null; articleReloadPending = false; for (const controller of controllers) controller.abort(); controllers.clear();
      items = []; loadedKey = ''; updatedAt = null; busy = false; saving = false; paperPage = 0; q('picker').replaceChildren(); q('updated').textContent = 'Noch keine Artikel geladen.';
      brandingKits = []; brandingLoaded = false; brandingMessage = ''; library = { templates: [], ownBranch: null, recipients: [], capabilities: {} };
      fillLogoChoices(form.elements.logoKitId.value, form.elements.logoAssetKey.value);
      libraryMode = 'defaults'; selectedTemplate = null; libraryReady = false; libraryLoading = false; fillLibrarySelect(); renderRecipients();
      q('library-title').value = ''; q('library-scope').value = 'private'; q('library-reload').hidden = true; q('saved').textContent = ''; render();
    }
    const workspace = {
      async load() {
        const nextOwner = accessKey(); if (owner !== nextOwner) { suspend(); form.elements.articleNumbers.value = ''; setOptions(defaults); setFileOptions(fileDefaults); }
        active = true; owner = nextOwner; const ticket = ++generation; libraryLoading = true; status('Gespeicherte Einstellungen werden geladen …'); render();
        const results = await Promise.allSettled([request('/api/sales/price-labels/templates'), request('/api/sales/price-labels/branding'), loadLibrary(ticket)]);
        if (!permitted(ticket)) return;
        libraryLoading = false;
        if (results[1].status === 'fulfilled') {
          brandingKits = Array.isArray(results[1].value.kits) ? results[1].value.kits : []; brandingMessage = '';
        } else brandingMessage = 'Branding-Kits sind gerade nicht erreichbar. Du kannst ohne Logo fortfahren.';
        brandingLoaded = true;
        if (results[0].status === 'fulfilled') {
          try { const saved = results[0].value; personalDefaults = { options: normalizeOptions(saved.options || defaults), filenameOptions: saved.filenameOptions || fileDefaults };
            setOptions(personalDefaults.options); setFileOptions(personalDefaults.filenameOptions); status('Artikelnummern eingeben und die aktuellen Preise laden.');
          } catch (error) { status(error.message, true); }
        } else if (results[0].reason?.name !== 'AbortError') status(results[0].reason.message, true);
        if (results[2].status === 'rejected' && results[2].reason?.name !== 'AbortError') q('saved').textContent = 'Die Vorlagenbibliothek ist gerade nicht erreichbar. Deine Standardeinstellung kannst du weiterhin speichern.';
        render();
      },
      async openArticle(article, templateId = '', {copy = false} = {}) {
        let ticket = generation;
        try {
          const initial = articleTemplateIntent(article, null), requestedOwner = accessKey();
          suspend(); const loading = workspace.load(); ticket = generation;
          await loading;
          if (owner !== requestedOwner || !permitted(ticket)) return false;
          if (templateId) {
            const template = await request('/api/sales/price-labels/library/' + encodeURIComponent(templateId));
            if (!permitted(ticket)) return false;
            const intent = articleTemplateIntent(initial.articleNumber, template, {copy});
            library.templates = [...library.templates.filter(item => item.id !== template.id), template];
            chooseTemplate(template.id);
            if (intent.copy) newTemplate(true);
            if (intent.copy && libraryMode !== 'new') throw new Error('Für eine eigene Kopie fehlt die Freigabe.');
          } else {
            chooseTemplate(''); newTemplate(false);
            if (libraryMode !== 'new') throw new Error('Für eine neue Vorlage fehlt die Freigabe.');
            q('library-title').value = 'Preisschild ' + initial.articleNumber;
          }
          form.elements.articleNumbers.value = initial.articleNumber;
          form.elements.priceType.value = 'sales';
          exportForm.elements.name.value = (q('library-title').value + '-' + initial.articleNumber).slice(0, 110);
          loadedKey = ''; render(); await loadArticles();
          return permitted(ticket);
        } catch (error) {
          if (permitted(ticket) && error.name !== 'AbortError') status(error.message, true);
          return false;
        }
      }, suspend,
      destroy() { suspend(); for (const off of listeners) off(); root.replaceChildren(); },
    };
    return workspace;
  }
  return { mount, defaults, labelFormats, labelFormat, applyLabelFormat, paperAdjustment, parseArticleNumbers, articleTemplateIntent, normalizeOptions, boundedLogo, logoFrame, paperLayout, pagePreview, price };
});
