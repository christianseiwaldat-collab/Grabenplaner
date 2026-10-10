import {createZip} from './gp-gallery-zip.mjs';
import {attachStudioWindow} from './gp-gallery-window.mjs';
export const MAX_ZIP_BYTES = 250 * 1024 * 1024;
export function safePart(value, fallback = 'Bild') {
  const clean = String(value ?? '').normalize('NFC').replace(/[\x00-\x1f<>:"/\\|?*]/g, '_').replace(/^[. ]+|[. ]+$/g, '').slice(0, 110);
  return clean && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(clean) ? clean : fallback;
}
export function downloadItems(items, {scope = 'view', selected = [], visible = [], folderId = '', descendants = true} = {}, folders = []) {
  if (!['all', 'selection', 'view', 'folder'].includes(scope)) throw Error('Ungültiger Download-Bereich.');
  const ids = new Set(scope === 'selection' ? selected : visible), folderIds = new Set([folderId]);
  if (scope === 'folder' && folderId && !folders.some(folder => folder.id === folderId)) throw Error('Dieser Ordner ist nicht verfügbar.');
  if (descendants && scope === 'folder' && folderId) {let changed; do {changed = false; for (const folder of folders) if (folderIds.has(folder.parentId) && !folderIds.has(folder.id)) {folderIds.add(folder.id); changed = true;}} while (changed);}
  return items.filter(item => !item.deletedAt && (scope === 'all' || (scope === 'folder' ? folderIds.has(item.folderId || '') : ids.has(item.id))));
}
function folderPaths(folders) {
  const result = new Map(), used = new Set();
  const get = (id, seen = new Set()) => {if (!id) return ''; if (result.has(id)) return result.get(id); const folder = folders.find(value => value.id === id); if (!folder || seen.has(id)) return 'Ohne Ordner'; seen.add(id); const parent = get(folder.parentId, seen); const base = [parent, safePart(folder.name, 'Ordner')].filter(Boolean).join('/'); let name = base, n = 2; while (used.has(name.toLowerCase())) name = base + '_' + n++; used.add(name.toLowerCase()); result.set(id, name); return name;};
  for (const folder of folders) get(folder.id); return result;
}
export async function downloadEntries(items, folders, options, readAsset, onProgress = () => {}) {
  if (!items.length) throw Error('Für diesen Download gibt es keine Bilder.');
  if (items.length > 1000) throw Error('Ein ZIP kann höchstens 1.000 Bilder enthalten.');
  if (!options.images && !options.text && !options.metadata) throw Error('Bitte Bilder, Text oder technische Daten auswählen.');
  const entries = [], names = new Set(['manifest.json']), manifest = [], paths = folderPaths(folders); let total = 0;
  const unique = name => {let candidate = name, n = 2; const dot = name.lastIndexOf('.'), base = dot > name.lastIndexOf('/') ? name.slice(0, dot) : name, ext = base === name ? '' : name.slice(dot); while (names.has(candidate.toLowerCase())) candidate = base + '_' + n++ + ext; names.add(candidate.toLowerCase()); return candidate;};
  const add = (name, data) => {total += typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength; if (total > MAX_ZIP_BYTES) throw Error('Dieses ZIP überschreitet 250 MB. Bitte kleinere Ordner oder eine Auswahl herunterladen.'); const actual = unique(name); entries.push({name: actual, data}); return actual;};
  for (const [index, item] of items.entries()) {
    const prefix = options.structure ? (item.folderId ? paths.get(item.folderId) || 'Ohne Ordner' : 'Ohne Ordner') + '/' : '';
    const stem = safePart((item.filename || item.title || 'Bild').replace(/\.[^.]+$/, '')), files = [];
    if (options.images) for (const asset of item.assets || [{url: item.url, filename: item.filename, kind: 'image'}]) {
      if (!asset.url) throw Error('Eine Bilddatei ist nicht verfügbar.');
      const data = await readAsset(asset, item, MAX_ZIP_BYTES - total); if (!(data instanceof Uint8Array)) throw Error('Eine Bilddatei konnte nicht gelesen werden.');
      files.push({kind: asset.kind || 'image', name: add(prefix + safePart(asset.filename || item.filename, stem + '.png'), data)});
    }
    if (options.text && typeof item.text === 'string' && item.text.trim()) files.push({kind: 'text', name: add(prefix + stem + '.txt', item.text.trim() + '\n')});
    if (options.metadata) files.push({kind: 'metadata', name: add(prefix + stem + '.json', JSON.stringify({schema: 'gp-gallery-item/1', id: item.id, title: item.title, folder: item.folderLabel || null, ...item.metadata}, null, 2) + '\n')});
    manifest.push({id: item.id, title: item.title, folder: item.folderLabel || null, files}); onProgress(index + 1, items.length);
  }
  if (options.manifest !== false) {names.delete('manifest.json'); add('manifest.json', JSON.stringify({schema: 'gp-gallery/1', createdAt: new Date().toISOString(), items: manifest}, null, 2) + '\n');}
  if (!entries.length) throw Error('Für diese Optionen sind keine Dateien verfügbar.'); return entries;
}
export async function readSameOriginAsset(asset, item, remaining) {
  const url = new URL(asset.url, location.href); if (url.origin !== location.origin) throw Error('Die Bildadresse ist nicht freigegeben.');
  const response = await fetch(url, {credentials: 'same-origin', cache: 'no-store'}); if (!response.ok) throw Error('Eine Bilddatei ist nicht mehr freigegeben. Bitte Galerie aktualisieren.');
  if (Number(response.headers.get('Content-Length')) > remaining) {await response.body?.cancel(); throw Error('Dieses ZIP überschreitet 250 MB.');}
  const reader = response.body.getReader(), chunks = []; let length = 0;
  try {for (;;) {const {done, value} = await reader.read(); if (done) break; length += value.length; if (length > remaining) throw Error('Dieses ZIP überschreitet 250 MB.'); chunks.push(value);}} catch (error) {await reader.cancel(); throw error;}
  const result = new Uint8Array(length); let offset = 0; for (const chunk of chunks) {result.set(chunk, offset); offset += chunk.length;} return result;
}
export function attachDownload(root, {key, snapshot, readAsset = readSameOriginAsset}) {
  const doc = root.ownerDocument, node = (tag, text) => {const el = doc.createElement(tag); if (text !== undefined) el.textContent = text; return el;};
  const dialog = node('dialog'); dialog.className = 'gp-gallery-download settings-window'; dialog.setAttribute('aria-label', 'ZIP-Download');
  const head = node('div'); head.className = 'window-titlebar'; head.dataset.windowTitle = ''; head.tabIndex = 0; head.append(node('h2', 'ZIP-Download'));
  const controls = node('div'); controls.className = 'window-controls'; const minimize = node('button', '−'), close = node('button', '×'); minimize.type = close.type = 'button'; minimize.dataset.windowToggle = ''; minimize.setAttribute('aria-label', 'ZIP-Download minimieren'); close.setAttribute('aria-label', 'ZIP-Download schließen'); controls.append(minimize, close); head.append(controls);
  const body = node('div'); body.className = 'window-body'; const form = node('form'); form.className = 'window-content';
  const field = (label, control) => {const el = node('label', label); el.append(control); return el;}, option = (value, label) => {const el = node('option', label); el.value = value; return el;};
  const scope = node('select'); scope.setAttribute('aria-label', 'Download-Bereich'); scope.append(option('selection', 'Ausgewählte Bilder'), option('view', 'Aktuelle Ansicht'), option('folder', 'Ganzer Ordner'), option('all', 'Ganze Galerie'));
  const folder = node('select'); folder.setAttribute('aria-label', 'Download-Ordner'); const folderField = field('Ordner', folder), checks = {};
  form.append(field('Download-Bereich', scope), folderField);
  for (const [key, label, checked] of [['descendants', 'Unterordner einschließen', true], ['images', 'Bilder einschließlich Original und Ergebnis', true], ['text', 'Beschreibung / Prompt als TXT', true], ['metadata', 'Technische Daten als JSON', true], ['structure', 'Ordnerstruktur im ZIP behalten', true], ['manifest', 'Dateiverzeichnis beilegen', true]]) {const check = node('input'); check.type = 'checkbox'; check.checked = checked; checks[key] = check; const labelEl = field(label, check); labelEl.className = 'gp-gallery-zip-option'; form.append(labelEl);}
  const note = node('p', 'Ganze Ordner enthalten alle zugeordneten Bilder unabhängig von Suchfiltern. Der Papierkorb wird ausgelassen. Bis zu 250 MB pro ZIP.'); note.className = 'fine'; const status = node('p'); status.setAttribute('role', 'status'); status.setAttribute('aria-live', 'polite'); const submit = node('button', 'ZIP vorbereiten'); submit.type = 'submit'; submit.className = 'primary'; const link = node('a', 'ZIP speichern'); link.className = 'download'; link.hidden = true; form.append(note, submit, status, link); body.append(form); dialog.append(head, body); doc.body.append(dialog);
  const shell = attachStudioWindow(dialog, {key: key + '.zip', width: 590, height: 660}); let busy = false, dead = false, url = null, controllerGeneration = 0;
  const clear = () => {controllerGeneration++; if (url) URL.revokeObjectURL(url); url = null; link.hidden = true; link.removeAttribute('href'); status.textContent = '';};
  const update = () => {folderField.hidden = scope.value !== 'folder'; checks.descendants.parentElement.hidden = scope.value !== 'folder'; clear();}; scope.addEventListener('change', update); form.addEventListener('change', clear); close.addEventListener('click', () => dialog.close()); dialog.addEventListener('close', clear);
  form.addEventListener('submit', async event => {event.preventDefault(); if (busy || dead) return; clear(); const generation = controllerGeneration, state = snapshot(); const opts = Object.fromEntries(Object.entries(checks).map(([key, check]) => [key, check.checked])); let items=[]; busy = true; for (const el of form.querySelectorAll('input,select,button')) el.disabled = true; status.textContent = 'ZIP wird vorbereitet …';
    try {items=downloadItems(state.items,{scope:scope.value,folderId:folder.value,selected:state.selected,visible:state.visible,descendants:opts.descendants},state.folders);const entries = await downloadEntries(items, state.folders, opts, async (...args) => {if (generation !== controllerGeneration || dead) throw Error('Download abgebrochen.'); return readAsset(...args);}, (done, total) => {if (generation === controllerGeneration && !dead) status.textContent = done + ' / ' + total + ' Bilder geladen';}); if (generation !== controllerGeneration || dead) return; const zip = createZip(entries); url = URL.createObjectURL(zip); link.href = url; link.download = 'GP-Galerie_' + new Intl.DateTimeFormat('en-CA',{timeZone:'Europe/Vienna',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date()) + '.zip'; link.hidden = false; status.textContent = items.length + ' Bilder · ZIP bereit zum Speichern.';} catch (error) {if (generation === controllerGeneration && !dead) status.textContent = error.message;} finally {busy = false; if (!dead) for (const el of form.querySelectorAll('input,select,button')) el.disabled = false;}
  });
  return {show() {if (dead) return; clear(); const state = snapshot(); folder.replaceChildren(option('', 'Ohne Ordner'), ...state.folders.map(value => option(value.id, value.label || value.name))); scope.value = state.selected.length ? 'selection' : 'view'; update(); shell.show(); shell.restore();}, dispose() {dead = true; clear(); dialog.close(); dialog.remove();}};
}
