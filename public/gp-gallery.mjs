// Shared GP gallery. Adapters supply authorized items and own all persistence.
import {attachDownload} from './gp-gallery-download.mjs';
export const VERSION = 2;
const SORTS = ['date', 'name', 'type', 'size', 'dimensions', 'model', 'quality', 'status'];
const normalize = value => String(value ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLocaleLowerCase('de');
const compare = new Intl.Collator('de', {numeric: true, sensitivity: 'base'});
export function preferenceKey(ownerKey, scope) {
  if (!ownerKey || !scope) throw new TypeError('Galerie benötigt Konto und Bereich.');
  return 'gp.gallery.v1.' + encodeURIComponent(ownerKey) + '.' + encodeURIComponent(scope);
}
export function viewPreferences(value = {}) {
  return {size: Math.max(140, Math.min(420, Number(value.size) || 200)), sort: SORTS.includes(value.sort) ? value.sort : 'date', direction: value.direction === 'asc' ? 'asc' : 'desc'};
}
export function queryItems(items, query = {}) {
  const terms = normalize(query.search).trim().split(/\s+/).filter(Boolean);
  const selected = items.filter(item => {
    if (Boolean(item.deletedAt) !== (query.folder === 'trash')) return false;
    if (query.folder && !['all', 'trash'].includes(query.folder) && (item.folderId || 'none') !== query.folder) return false;
    if (Object.entries(query.filters || {}).some(([key, value]) => value && item[key] !== value)) return false;
    const content = normalize([item.title, item.filename, item.searchText, item.folderLabel, item.model, item.quality, item.status].join(' '));
    return terms.every(term => content.includes(term));
  });
  const {sort, direction} = viewPreferences(query);
  const value = item => sort === 'date' ? Date.parse(item.createdAt) : sort === 'name' ? item.title : sort === 'size' ? item.bytes : sort === 'dimensions' ? item.width * item.height : item[sort];
  return selected.sort((a, b) => {
    const av = value(a), bv = value(b), missingA = av == null || (typeof av === 'number' && !Number.isFinite(av)), missingB = bv == null || (typeof bv === 'number' && !Number.isFinite(bv));
    if (missingA || missingB) return missingA === missingB ? compare.compare(a.id, b.id) : missingA ? 1 : -1;
    const result = typeof av === 'number' ? av - bv : compare.compare(av, bv);
    return (direction === 'asc' ? result : -result) || compare.compare(a.id, b.id);
  });
}
export function createModel({selected = new Set(), preferences = {}} = {}) {
  let items = [], query = {...viewPreferences(preferences), search: '', folder: 'all', filters: {}}, anchor = null;
  const shown = () => queryItems(items, query);
  const reconcile = () => {const ids = new Set(shown().map(item => item.id)); for (const id of selected) if (!ids.has(id)) selected.delete(id);};
  return {
    update(next) {if (!Array.isArray(next) || next.some(item => !item.id) || new Set(next.map(item => item.id)).size !== next.length) throw new TypeError('Galerie benötigt eindeutige Bildkennungen.'); items = next; reconcile();},
    query(patch) {query = {...query, ...patch, ...viewPreferences({...query, ...patch})}; reconcile();},
    toggle(id, checked, range = false) {const list = shown(); if (!list.some(item => item.id === id)) return; const from = list.findIndex(item => item.id === anchor), to = list.findIndex(item => item.id === id); const ids = range && from >= 0 ? list.slice(Math.min(from, to), Math.max(from, to) + 1).map(item => item.id) : [id]; for (const key of ids) checked ? selected.add(key) : selected.delete(key); anchor = id;},
    selectAll(checked) {selected.clear(); if (checked) shown().forEach(item => selected.add(item.id));},
    clear() {selected.clear(); anchor = null;},
    dispose() {items = []; selected.clear(); query = {...viewPreferences(), search: '', folder: 'all', filters: {}}; anchor = null;},
    visible: shown, chosen: () => shown().filter(item => selected.has(item.id)), all: () => [...items],
    get state() {return {...query, filters: {...query.filters}, selected: new Set(selected)};},
  };
}
export function mount(root, {ownerKey, scope, selected, onOpen = () => {}, onAction = () => {}, onRefresh = () => {}, onManageFolders, readAsset, actions = ['move', 'trash', 'restore', 'purge'], filters = [], emptyLabel = 'Noch keine Bilder in dieser Galerie.', extraActions = []} = {}) {
  const doc = root.ownerDocument, win = doc.defaultView, key = preferenceKey(ownerKey, scope), handlers = [];
  let stored = {}; try {stored = JSON.parse(win.localStorage.getItem(key) || '{}');} catch {}
  const model = createModel({selected, preferences: stored}); let folders = [], locked = false, dead = false;
  const download = attachDownload(root, {key, readAsset, snapshot: () => ({items: model.all(), folders, selected: model.chosen().map(item => item.id), visible: model.visible().map(item => item.id)})});
  const node = (tag, text, cls) => {const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; if (cls) el.className = cls; return el;};
  const on = (el, type, fn) => {el.addEventListener(type, fn); handlers.push(() => el.removeEventListener(type, fn));};
  const button = (text, fn) => {const el = node('button', text); el.type = 'button'; on(el, 'click', fn); return el;};
  const option = (value, text) => {const el = node('option', text); el.value = value; return el;};
  const label = (text, el) => {const out = node('label', text); out.append(el); return out;};
  root.classList.add('gp-gallery'); root.dataset.gpGalleryVersion = String(VERSION);
  const heading = node('div', undefined, 'gp-gallery-heading'), title = node('h2', 'Deine Sammlung '), count = node('span', '0', 'gp-gallery-count'); title.append(count);
  const search = node('input'); search.type = 'search'; search.placeholder = 'Bilder durchsuchen'; search.maxLength = 300; search.setAttribute('aria-label', 'Bilder durchsuchen');
  heading.append(title, search, button('Aktualisieren', () => onRefresh()));
  const nav = node('nav', undefined, 'gp-gallery-nav'); nav.setAttribute('aria-label', 'Galerieordner');
  const toolbar = node('div', undefined, 'gp-gallery-toolbar'), size = node('input'), sizeLabel = node('output'); size.type = 'range'; size.min = '140'; size.max = '420'; size.step = '10'; size.value = String(model.state.size); size.setAttribute('aria-label', 'Bildgröße');
  const sortDetails = node('details'), sortSummary = node('summary'), sort = node('select'), direction = node('select'); sort.setAttribute('aria-label', 'Sortieren nach'); direction.setAttribute('aria-label', 'Reihenfolge');
  const sortLabels = {date: 'Datum', name: 'Name / Beschreibung', type: 'Dateityp', size: 'Dateigröße', dimensions: 'Bildgröße · Pixel', model: 'Modell', quality: 'Qualität', status: 'Status'};
  for (const value of SORTS) sort.append(option(value, sortLabels[value])); direction.append(option('desc', 'Absteigend ↓'), option('asc', 'Aufsteigend ↑')); sort.value = model.state.sort; direction.value = model.state.direction;
  const sortFields = node('div', undefined, 'gp-gallery-fields'); sortFields.append(label('Sortieren nach', sort), label('Reihenfolge', direction)); sortDetails.append(sortSummary, sortFields);
  const filterDetails = node('details'), filterSummary = node('summary', 'Filtern'), filterFields = node('div', undefined, 'gp-gallery-fields'), filterControls = new Map();
  for (const field of filters) {const select = node('select'); select.setAttribute('aria-label', field.label); select.append(option('', 'Alle')); for (const item of field.options || []) select.append(option(item.value ?? item, item.label ?? item)); filterControls.set(field.key, select); filterFields.append(label(field.label, select)); on(select, 'change', () => change());}
  filterFields.append(button('Zurücksetzen', () => {search.value = ''; for (const control of filterControls.values()) control.value = ''; change();})); filterDetails.append(filterSummary, filterFields);
  toolbar.append(label('Bildgröße', size), sizeLabel, sortDetails, filterDetails); if (onManageFolders) toolbar.append(button('Ordner verwalten', () => onManageFolders()));
  const zipButton = button('ZIP-Download', () => download.show()); toolbar.append(zipButton);
  const status = node('p', '', 'gp-gallery-query-status'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite');
  const selection = node('div', undefined, 'gp-gallery-selection'), all = node('input'), selectedCount = node('strong'), target = node('select'); all.type = 'checkbox'; all.setAttribute('aria-label', 'Alle sichtbaren Bilder auswählen'); target.setAttribute('aria-label', 'Zielordner für Auswahl');
  selection.append(label('Alle auswählen', all), selectedCount, button('Auswahl aufheben', () => {model.clear(); render();})); if (actions.includes('move')) selection.append(target);
  const actionButtons = new Map();
  const labels = {move: 'Verschieben', trash: 'In den Papierkorb', restore: 'Wiederherstellen', purge: 'Endgültig entfernen'};
  for (const action of actions) {const el = button(labels[action], () => {const chosen = model.chosen(); if (!chosen.length) return; if (action === 'purge' && !win.confirm('Ausgewählte Dateien endgültig entfernen? Dieser Schritt lässt sich nicht rückgängig machen.')) return; onAction(action, chosen, target.value || null);}); actionButtons.set(action, el); selection.append(el);}
  for (const item of extraActions) {const el = button(item.label, () => item.run(model.chosen())); actionButtons.set(item.id, el); selection.append(el);}
  const grid = node('div', undefined, 'gp-gallery-grid'); root.replaceChildren(heading, nav, toolbar, status, selection, grid);
  const date = value => {const parsed = new Date(value); return Number.isFinite(parsed.getTime()) ? new Intl.DateTimeFormat('de-AT', {dateStyle: 'short', timeStyle: 'short'}).format(parsed) : 'Zeitpunkt unbekannt';};
  const bytes = value => !Number.isFinite(value) ? 'Größe unbekannt' : value >= 1048576 ? (value / 1048576).toFixed(1) + ' MB' : (value / 1024).toFixed(1) + ' KB';
  const safeUrl = value => {try {const url = new URL(value, win.location.href); return url.origin === win.location.origin || url.protocol === 'blob:' ? url.href : ''; } catch {return '';}};
  function save() {try {win.localStorage.setItem(key, JSON.stringify(viewPreferences(model.state)));} catch {}}
  function change() {model.query({search: search.value, size: size.value, sort: sort.value, direction: direction.value, filters: Object.fromEntries([...filterControls].map(([key, control]) => [key, control.value]))}); save(); render();}
  function render() {
    if (dead) return; const state = model.state, shown = model.visible(), chosen = model.chosen(); root.style.setProperty('--gp-gallery-size', state.size + 'px'); sizeLabel.textContent = state.size + ' px'; sortSummary.textContent = 'Sortieren · ' + sortLabels[state.sort] + (state.direction === 'desc' ? ' ↓' : ' ↑');
    zipButton.disabled = locked || !model.allCount;
    const activeFilters = Object.values(state.filters).filter(Boolean).length; filterSummary.textContent = 'Filtern' + (activeFilters ? ' · ' + activeFilters + ' aktiv' : '');
    count.textContent = String(model.allCount); status.textContent = shown.length + ' Bilder' + (state.folder === 'trash' ? ' im Papierkorb' : ' in dieser Ansicht'); selectedCount.textContent = chosen.length + ' ausgewählt'; all.checked = shown.length > 0 && chosen.length === shown.length; all.indeterminate = chosen.length > 0 && chosen.length < shown.length;
    nav.replaceChildren(); for (const folder of [{id: 'all', name: 'Alle Bilder'}, {id: 'none', name: 'Ohne Ordner'}, ...folders, {id: 'trash', name: 'Papierkorb'}]) {const el = node('button', folder.label || folder.name); el.type = 'button'; el.setAttribute('aria-pressed', String(state.folder === folder.id)); el.addEventListener('click', () => {model.clear(); model.query({folder: folder.id}); render();}); nav.append(el);}
    const before = target.value; target.replaceChildren(option('', 'Ohne Ordner'), ...folders.map(folder => option(folder.id, folder.label || folder.name))); target.value = folders.some(folder => folder.id === before) ? before : ''; target.hidden = state.folder === 'trash';
    for (const [action, el] of actionButtons) {el.disabled = locked || !chosen.length; el.hidden = ['restore', 'purge'].includes(action) ? state.folder !== 'trash' : ['trash', 'move'].includes(action) && state.folder === 'trash';}
    grid.replaceChildren(); if (!shown.length) grid.append(node('p', state.folder === 'trash' ? 'Der Papierkorb ist leer.' : model.allCount ? 'Keine Bilder passen zu dieser Ansicht.' : emptyLabel, 'gp-gallery-empty'));
    for (const item of shown) {const card = node('article', undefined, 'gp-gallery-card' + (state.selected.has(item.id) ? ' is-selected' : '')); card.dataset.id = item.id;
      const check = node('input'); check.type = 'checkbox'; check.checked = state.selected.has(item.id); check.setAttribute('aria-label', 'Bild auswählen: ' + item.title); check.addEventListener('click', event => {model.toggle(item.id, check.checked, event.shiftKey); render();});
      const select = node('label', undefined, 'gp-gallery-select'); select.append(check); card.append(select);
      const open = node('button', undefined, 'gp-gallery-open'); open.type = 'button'; open.setAttribute('aria-label', 'Bild öffnen: ' + item.title); const image = node('img'); const url = safeUrl(item.thumbnailUrl || item.url); if (url) image.src = url; image.alt = item.title; image.loading = 'lazy'; open.append(image); open.addEventListener('click', () => onOpen(item)); card.append(open);
      const info = node('div', undefined, 'gp-gallery-card-info'); info.append(node('h3', item.title), node('p', date(item.createdAt) + (item.modelLabel ? ' · ' + item.modelLabel : '')), node('p', item.width + ' × ' + item.height + ' · ' + bytes(item.bytes) + (item.statusLabel ? ' · ' + item.statusLabel : ''))); if (item.folderLabel) info.append(node('p', item.folderLabel));
      const links = node('div', undefined, 'gp-gallery-card-actions'), download = node('a', (item.type || 'Bild').toUpperCase() + ' ↓'); const href = safeUrl(item.downloadUrl || item.url); if (href) download.href = href; download.download = item.filename || ''; links.append(download); const view = node('button', 'Öffnen'); view.type = 'button'; view.addEventListener('click', () => onOpen(item)); links.append(view); info.append(links); card.append(info); grid.append(card);
    }
  }
  on(search, 'input', change); for (const el of [sort, direction]) on(el, 'change', change); on(size, 'input', change); on(all, 'change', () => {model.selectAll(all.checked); render();});
  return {update({items, folders: nextFolders = [], busy = false}) {if (dead) return; folders = nextFolders; locked = busy; model.update(items); model.allCount = items.filter(item => !item.deletedAt).length; if (!['all', 'none', 'trash', ...folders.map(folder => folder.id)].includes(model.state.folder)) model.query({folder: 'all'}); render();}, visible: model.visible, chosen: model.chosen, clearSelection() {model.clear(); render();}, render, get state() {return model.state;}, dispose() {dead = true; download.dispose(); model.dispose(); handlers.forEach(remove => remove()); root.replaceChildren();}};
}
