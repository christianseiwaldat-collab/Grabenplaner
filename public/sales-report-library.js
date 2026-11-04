'use strict';
window.createSalesReportLibraryUi = function ({ api, reportActions = () => [], reportSummary = () => '', editTemplate, deleteTemplate, onError }) {
  const Options = window.SalesReportLibraryOptions, el = id => document.getElementById(id);
  const root = el('salesAnalyticsReportsPanel'), list = el('salesReportJobList'), dialog = el('salesLibraryDialog'), menu = el('salesLibraryContextMenu');
  const node = (tag, text = '', cls = '') => { const n = document.createElement(tag); n.textContent = text; n.className = cls; return n; };
  let state = { revision: 0, folders: [], items: [] }, preferences = Options.defaults(), reports = [], templates = [];
  let current = '', generation = 0, busy = false, selected = '', resize = null, columnsOpen = false, menuTrigger = null;
  const token = () => globalThis.crypto?.randomUUID?.() || String(Date.now()) + Math.random();
  let mutations = Promise.resolve(), dragToken = token(), expanded = new Set(['']);
  const statuses = { queued: 'Wartet', running: 'Wird erstellt', completed: 'Fertig', failed: 'Fehlgeschlagen', cancelled: 'Abgebrochen' };
  const info = text => { el('salesLibraryFeedback').textContent = text; };
  const metadata = (item, kind) => state.items.find(i => i.id === item.id && i.kind === kind);
  const title = (item, kind) => metadata(item, kind)?.title || item.title;
  const folderOf = (item, kind) => metadata(item, kind)?.folderId || '';
  const keyOf = entry => entry.kind + ':' + entry.id;
  const date = value => value && Number.isFinite(Date.parse(value)) ? new Date(value).toLocaleString('de-AT', { dateStyle: 'medium', timeStyle: 'short' }) : 'Nicht erfasst';
  const author = value => value ? 'Personalnr. ' + value : 'Nicht erfasst';
  const latest = (a, b) => [a, b].filter(v => v && Number.isFinite(Date.parse(v))).sort().at(-1) || null;
  function button(text, action, cls = 'sales-library-action-link') {
    const b = node('button', text, cls); b.type = 'button'; b.disabled = busy;
    b.addEventListener('click', event => { event.stopPropagation(); void Promise.resolve().then(() => action(b)).catch(onError); }); return b;
  }
  function inside(id, ancestor) {
    if (!ancestor) return false;
    for (let depth = 0; id && depth <= 100; depth++) { if (id === ancestor) return true; id = state.folders.find(f => f.id === id)?.parentId; }
    return false;
  }
  function folderLabel(id) {
    const parts = []; let f = state.folders.find(f => f.id === id);
    while (f && parts.length <= 100) { parts.unshift(f.title); f = state.folders.find(p => p.id === f.parentId); }
    return ['Berichte', ...parts].join(' / ');
  }
  function entries() {
    return [...state.folders.map(f => ({ ...f, kind: 'folder', folderId: f.parentId, type: 'Ordner', status: '' })),
      ...templates.map(t => ({ ...t, kind: 'template', original: t, title: title(t, 'template'), folderId: folderOf(t, 'template'), type: t.kind === 'graphic' ? 'Grafikvorlage' : 'Berichtsvorlage', status: 'Vorlage', updated: latest(metadata(t, 'template')?.updated, t.updated) })),
      ...reports.map(r => ({ ...r, kind: 'report', original: r, title: title(r, 'report'), folderId: folderOf(r, 'report'), type: r.query?.chartType === 'timeline' ? 'Grafik-PDF' : r.format === 'pdf' ? 'PDF-Bericht' : 'HTML-Bericht', status: statuses[r.status] || r.status, updated: latest(metadata(r, 'report')?.updated, r.updated) }))];
  }
  function closeMenu(restore = false) { menu.hidden = true; menu.replaceChildren(); if (restore && menuTrigger?.isConnected) menuTrigger.focus(); }
  function open(id) { let ancestor = id; expanded.add(''); for (let depth = 0; ancestor && depth <= 100; depth++) { expanded.add(ancestor); ancestor = state.folders.find(f => f.id === ancestor)?.parentId; } current = id; selected = ''; el('salesReportJobFilter').value = ''; render(); }
  function ask(heading, { name, target, note = '', confirm = false, exclude = '' } = {}) {
    if (dialog.open) return Promise.resolve(null);
    el('salesLibraryDialogTitle').textContent = heading;
    el('salesLibraryNameField').hidden = name === undefined; el('salesLibraryName').disabled = name === undefined; el('salesLibraryName').value = name || '';
    el('salesLibraryTargetField').hidden = target === undefined;
    el('salesLibraryTarget').replaceChildren(new Option('Berichte (Hauptordner)', ''), ...state.folders.filter(f => !inside(f.id, exclude)).sort((a, b) => folderLabel(a.id).localeCompare(folderLabel(b.id), 'de-AT')).map(f => new Option(folderLabel(f.id), f.id)));
    el('salesLibraryTarget').value = target || ''; el('salesLibraryDialogNote').textContent = note; el('salesLibraryDialogOk').textContent = confirm ? 'Löschen' : 'Speichern'; dialog.returnValue = '';
    return new Promise(resolve => { dialog.addEventListener('close', () => resolve(dialog.returnValue === 'ok' ? { title: el('salesLibraryName').value.trim(), parentId: el('salesLibraryTarget').value } : null), { once: true }); dialog.showModal(); (name === undefined ? el('salesLibraryDialogOk') : el('salesLibraryName')).focus(); });
  }
  function change(input) {
    const g = generation;
    const task = mutations.catch(() => {}).then(async () => {
      if (g !== generation) return; busy = true; root.setAttribute('aria-busy', 'true');
      try {
        const next = await api('/api/sales-report-library', { method: 'PATCH', body: JSON.stringify({ revision: state.revision, ...input }) });
        if (g === generation) { state = next; info(input.action === 'preferences' ? 'Ansicht gespeichert.' : 'Ablage aktualisiert.'); }
      } catch (error) {
        if (g !== generation) return;
        if (error.code === 'IMPORT_REVISION_CONFLICT') { const fresh = await api('/api/sales-report-library'); if (g === generation) state = fresh; }
        if (g === generation) { info('Die Änderung wurde nicht gespeichert. Bitte erneut versuchen.'); throw error; }
      } finally { if (g === generation) { busy = false; root.removeAttribute('aria-busy'); render(); } }
    });
    mutations = task.catch(() => {}); return task;
  }
  function layout(next, rerender = true) { preferences = Options.normalize(next); if (rerender) render(); void change({ action: 'preferences', preferences: structuredClone(preferences) }).catch(onError); }
  async function newFolder(parentId = current) { const v = await ask('Neuer Ordner', { name: '' }); if (v) await change({ action: 'createFolder', parentId, title: v.title }); }
  async function rename(entry) {
    const v = await ask(entry.kind === 'folder' ? 'Ordner umbenennen' : 'Umbenennen', { name: entry.title, note: entry.kind === 'report' ? 'Der Name in der Ablage ändert sich. Der Inhalt der bereits erstellten PDF bleibt erhalten.' : '' });
    if (v) await change({ action: entry.kind === 'folder' ? 'renameFolder' : 'renameItem', kind: entry.kind, id: entry.id, title: v.title });
  }
  async function move(entry) { const v = await ask('Verschieben', { target: entry.folderId, exclude: entry.kind === 'folder' ? entry.id : '' }); if (v) await change({ action: entry.kind === 'folder' ? 'moveFolder' : 'moveItem', kind: entry.kind, id: entry.id, parentId: v.parentId }); }
  async function removeFolder(entry) { if (await ask('Ordner löschen', { confirm: true, note: 'Den leeren Ordner „' + entry.title + '“ löschen? Enthaltene Dateien und Unterordner bitte zuerst verschieben.' })) await change({ action: 'deleteFolder', id: entry.id }); }
  function properties(entry) {
    const details = el('salesLibraryPropertiesDetails'); details.replaceChildren();
    const add = (label, value) => details.append(node('dt', label), node('dd', String(value)));
    el('salesLibraryPropertiesTitle').textContent = entry.title + ' · Eigenschaften';
    add('Typ', entry.type); add('Pfad', entry.kind === 'folder' ? folderLabel(entry.id) : folderLabel(entry.folderId));
    add('Erstellt am', date(entry.created)); add('Erstellt von', author(entry.createdBy)); add('Geändert am', date(entry.updated));
    if (entry.kind === 'folder') {
      const all = entries(), direct = all.filter(e => e.folderId === entry.id), nested = all.filter(e => !entry.id || inside(e.folderId, entry.id));
      add('Dateien direkt im Ordner', direct.filter(e => e.kind !== 'folder').length);
      add('Berichte inkl. Unterordner', nested.filter(e => e.kind === 'report').length);
      add('Vorlagen inkl. Unterordner', nested.filter(e => e.kind === 'template').length);
      add('Unterordner insgesamt', nested.filter(e => e.kind === 'folder').length);
    } else if (entry.kind === 'report') { add('Status', entry.status); add('Auswertung', reportSummary(entry.original)); }
    el('salesLibraryProperties').showModal();
  }
  function actions(entry) {
    if (entry.kind === 'folder') return [{ label: 'Öffnen', run: () => open(entry.id) }, { label: 'Neuer Unterordner', run: () => newFolder(entry.id) },
      ...(entry.id ? [{ label: 'Ordner umbenennen', run: () => rename(entry) }, { label: 'Ordner verschieben', run: () => move(entry) }, { label: 'Ordner löschen', run: () => removeFolder(entry) }] : []), { label: 'Eigenschaften', run: () => properties(entry) }];
    return [...(entry.kind === 'template' ? [{ label: 'Bearbeiten / Laden', primary: true, run: () => editTemplate(entry.id, entry.title) }] : reportActions({ ...entry.original, title: entry.title })),
      { label: 'Umbenennen', run: () => rename(entry) }, { label: 'Verschieben', run: () => move(entry) },
      ...(entry.kind === 'template' ? [{ label: 'Vorlage löschen', run: async () => { if (await ask('Vorlage löschen', { confirm: true, note: '„' + entry.title + '“ löschen? Bereits erstellte PDFs bleiben erhalten.' })) await deleteTemplate(entry.original); } }] : []), { label: 'Eigenschaften', run: () => properties(entry) }];
  }
  function openEntry(entry, target) { if (entry.kind === 'folder') open(entry.id); else { const choices = actions(entry); void Promise.resolve().then(() => (choices.find(a => a.primary) || choices[0])?.run(target)).catch(onError); } }
  function showMenu(event, entry, trigger) {
    event.preventDefault(); event.stopPropagation(); closeMenu(); selected = keyOf(entry); menuTrigger = trigger;
    menu.replaceChildren(...actions(entry).map(action => { const b = button(action.label, () => { closeMenu(); return action.run(trigger); }, 'sales-library-menu-item'); b.setAttribute('role', 'menuitem'); return b; })); menu.hidden = false;
    const rect = trigger.getBoundingClientRect(), x = event.type === 'contextmenu' && event.clientX ? event.clientX : rect.left, y = event.type === 'contextmenu' && event.clientY ? event.clientY : rect.bottom;
    menu.style.left = Math.max(8, Math.min(x, innerWidth - menu.offsetWidth - 8)) + 'px'; menu.style.top = Math.max(8, Math.min(y, innerHeight - menu.offsetHeight - 8)) + 'px'; menu.querySelector('button')?.focus();
  }
  function payload(event) { try { const value = JSON.parse(event.dataTransfer.getData('application/x-gp-report-library')); return value.token === dragToken ? entries().find(e => keyOf(e) === value.key) : null; } catch { return null; } }
  function performDrop(event, id) {
    event.preventDefault(); event.stopPropagation(); const entry = payload(event);
    if (!entry || busy || entry.folderId === id) return;
    if (entry.kind === 'folder' && inside(id, entry.id)) { info('Ein Ordner kann nicht in sich selbst oder in einen seiner Unterordner verschoben werden.'); return; }
    void change({ action: entry.kind === 'folder' ? 'moveFolder' : 'moveItem', kind: entry.kind, id: entry.id, parentId: id }).catch(onError);
  }
  function dropTarget(element, id) {
    element.dataset.dropFolder = id;
    element.addEventListener('dragover', event => { if (busy || ![...event.dataTransfer.types].includes('application/x-gp-report-library')) return; event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; element.classList.add('is-drop-target'); });
    element.addEventListener('dragleave', event => { if (!element.contains(event.relatedTarget)) element.classList.remove('is-drop-target'); });
    element.addEventListener('drop', event => { element.classList.remove('is-drop-target'); performDrop(event, id); });
  }
  function bindEntry(element, entry) {
    element.dataset.libraryKey = keyOf(entry); element.tabIndex = 0; element.setAttribute('aria-label', entry.title + ' · ' + entry.type); element.classList.toggle('is-selected', selected === keyOf(entry));
    element.addEventListener('click', () => { selected = keyOf(entry); for (const other of list.querySelectorAll('[data-library-key]')) other.classList.toggle('is-selected', other === element); });
    element.addEventListener('dblclick', event => { if (!event.target.closest('button')) openEntry(entry, element); });
    element.addEventListener('contextmenu', event => showMenu(event, entry, element));
    element.addEventListener('keydown', event => { if (event.target !== element) return; if (event.key === 'ContextMenu' || event.shiftKey && event.key === 'F10') showMenu(event, entry, element); else if (event.key === 'Enter') { event.preventDefault(); openEntry(entry, element); } else if (event.key === 'F2' && entry.id) { event.preventDefault(); void rename(entry).catch(onError); } });
    element.draggable = !!entry.id;
    element.addEventListener('dragstart', event => { if (busy || !entry.id) { event.preventDefault(); return; } closeMenu(); event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-gp-report-library', JSON.stringify({ token: dragToken, key: keyOf(entry) })); });
    if (entry.kind === 'folder') dropTarget(element, entry.id);
  }
  function moreButton(entry) { const b = button('⋯', target => showMenu({ preventDefault() {}, stopPropagation() {} }, entry, target), 'sales-library-more'); b.setAttribute('aria-label', entry.title + ' – Aktionen'); return b; }
  function field(entry, id) {
    if (id === 'name') return entry.title; if (id === 'folder') return folderLabel(entry.folderId);
    if (id === 'period') return entry.original?.query?.dateFrom ? entry.original.query.dateFrom + ' – ' + entry.original.query.dateTo : '';
    return entry[id] || '';
  }
  function visibleEntries() {
    const search = el('salesReportJobFilter').value.trim().toLocaleLowerCase('de-AT'), filter = el('salesLibraryFilter').value;
    return entries().filter(e => (search ? e.title.toLocaleLowerCase('de-AT').includes(search) : e.folderId === current) && (e.kind === 'folder' || filter === 'all' || e.kind === filter)).sort((a, b) => {
      if ((a.kind === 'folder') !== (b.kind === 'folder')) return a.kind === 'folder' ? -1 : 1;
      const av = field(a, preferences.sort), bv = field(b, preferences.sort); if (!av !== !bv) return av ? -1 : 1;
      return String(av).localeCompare(String(bv), 'de-AT', { numeric: true }) * (preferences.direction === 'desc' ? -1 : 1) || a.title.localeCompare(b.title, 'de-AT');
    });
  }
  function icon(entry) { const n = node('span', '', entry.kind === 'folder' ? 'sales-yellow-folder' : 'sales-library-file-icon'); n.setAttribute('aria-hidden', 'true'); if (entry.kind !== 'folder') n.dataset.fileKind = entry.type.startsWith('Grafik') ? 'graphic' : entry.kind; return n; }
  function columnsChooser() {
    const chooser = node('details', '', 'trade-column-chooser gp-table-layout-controls'); chooser.open = columnsOpen; chooser.append(node('summary', 'Spaltenanzeige')); chooser.addEventListener('toggle', () => { columnsOpen = chooser.open; });
    const box = node('div', '', 'trade-column-options'), ordered = [...preferences.columns.map(id => Options.COLUMNS.find(c => c.id === id)), ...Options.COLUMNS.filter(c => !preferences.columns.includes(c.id))];
    for (const column of ordered) {
      const label = node('label'), input = node('input'); input.type = 'checkbox'; input.checked = preferences.columns.includes(column.id); input.disabled = input.checked && preferences.columns.length === 1; input.setAttribute('aria-label', column.label + ' anzeigen'); label.append(input, node('span', column.label));
      input.addEventListener('change', () => layout({ ...preferences, columns: input.checked ? [...preferences.columns, column.id] : preferences.columns.filter(id => id !== column.id) }));
      if (input.checked) for (const offset of [-1, 1]) {
        const index = preferences.columns.indexOf(column.id), b = button(offset < 0 ? '←' : '→', () => { const next = [...preferences.columns]; [next[index], next[index + offset]] = [next[index + offset], next[index]]; layout({ ...preferences, columns: next }); }, 'sales-library-column-order');
        b.disabled = index + offset < 0 || index + offset >= preferences.columns.length; b.setAttribute('aria-label', column.label + (offset < 0 ? ' nach links' : ' nach rechts')); label.append(b);
      }
      box.append(label);
    }
    chooser.append(box); return chooser;
  }
  function renderDetails(values) {
    list.append(columnsChooser()); const scroll = node('div', '', 'sales-library-table-scroll'), table = node('table', '', 'sales-library-table');
    const columns = preferences.columns.map(id => Options.COLUMNS.find(c => c.id === id)), head = node('thead'), headings = node('tr');
    for (const column of columns) {
      const th = node('th'); th.scope = 'col'; th.dataset.column = column.id; th.setAttribute('aria-sort', preferences.sort === column.id ? preferences.direction === 'asc' ? 'ascending' : 'descending' : 'none');
      th.append(button(column.label + (preferences.sort === column.id ? preferences.direction === 'asc' ? ' ↑' : ' ↓' : ''), () => layout({ ...preferences, sort: column.id, direction: preferences.sort === column.id && preferences.direction === 'asc' ? 'desc' : 'asc' }), 'sales-library-sort'));
      const handle = node('button'); handle.type = 'button'; handle.setAttribute('data-gp-column-resize', column.id); handle.setAttribute('role', 'slider'); handle.setAttribute('aria-label', column.label + ' – Spaltenbreite'); handle.setAttribute('aria-valuemin', '80'); handle.setAttribute('aria-valuemax', '800'); handle.setAttribute('aria-orientation', 'horizontal'); th.append(handle); headings.append(th);
    }
    headings.append(node('th')); head.append(headings); const body = node('tbody');
    for (const entry of values) {
      const row = node('tr'); bindEntry(row, entry);
      for (const column of columns) { const raw = field(entry, column.id), value = ['created', 'updated'].includes(column.id) ? date(raw) : column.id === 'createdBy' ? author(raw) : raw || '–'; const cell = node('td', value); cell.title = value; if (column.id === 'name') cell.prepend(icon(entry)); row.append(cell); }
      const cell = node('td'); cell.append(moreButton(entry)); row.append(cell); body.append(row);
    }
    table.append(head, body); scroll.append(table); list.append(scroll);
    resize = window.GrabenplanerTableLayout.attach(table, { columns: () => [...columns, { id: 'actions', width: 40, resizable: false }], allowedColumns: () => Options.COLUMNS.map(c => c.id), widths: () => preferences.widths, canResize: () => !busy, change: widths => { preferences = { ...preferences, widths }; }, persist: () => layout(preferences, false) });
  }
  function render() {
    closeMenu(); resize?.destroy(); resize = null; if (current && !state.folders.some(f => f.id === current)) current = ''; el('salesLibraryView').value = preferences.view;
    const tree = el('salesLibraryFolders'); tree.replaceChildren();
    function branch(id, depth = 0) {
      const folder = state.folders.find(f => f.id === id), entry = { ...folder, id, kind: 'folder', type: 'Ordner', title: folder?.title || 'Berichte', folderId: folder?.parentId || '' };
      const children = state.folders.filter(f => f.parentId === id).sort((a, b) => a.title.localeCompare(b.title, 'de-AT', { numeric: true }));
      const row = node('div', '', 'sales-library-tree-row'); row.style.setProperty('--folder-depth', depth);
      const toggle = button('', () => { if (expanded.has(id)) expanded.delete(id); else expanded.add(id); render(); tree.querySelector('[data-folder-toggle="' + CSS.escape(id) + '"]')?.focus(); }, 'sales-library-tree-toggle');
      toggle.dataset.folderToggle = id; toggle.disabled = !children.length; toggle.setAttribute('aria-label', entry.title + (expanded.has(id) ? ' einklappen' : ' ausklappen'));
      if (children.length) toggle.setAttribute('aria-expanded', String(expanded.has(id)));
      const b = button(entry.title, () => open(id), 'sales-library-folder'); b.setAttribute('aria-current', String(current === id)); b.prepend(icon(entry)); bindEntry(b, entry); b.setAttribute('aria-label', entry.title);
      b.addEventListener('keydown', event => { if (event.key === 'ArrowRight' && children.length || event.key === 'ArrowLeft' && expanded.has(id)) { event.preventDefault(); if (event.key === 'ArrowRight') expanded.add(id); else expanded.delete(id); render(); tree.querySelector('[data-drop-folder="' + CSS.escape(id) + '"]')?.focus(); } });
      row.append(toggle, b); tree.append(row);
      if (expanded.has(id)) for (const child of children) branch(child.id, depth + 1);
    }
    branch('');
    const crumbs = el('salesLibraryBreadcrumbs'), home = button('Berichte', () => open(''), 'text-button'); dropTarget(home, ''); crumbs.replaceChildren(home);
    const ancestors = []; let folder = state.folders.find(f => f.id === current); while (folder) { ancestors.unshift(folder); folder = state.folders.find(f => f.id === folder.parentId); }
    for (const ancestor of ancestors) { const b = button(ancestor.title, () => open(ancestor.id), 'text-button'); dropTarget(b, ancestor.id); crumbs.append(node('span', '›'), b); }
    list.replaceChildren(); list.dataset.view = preferences.view; const values = visibleEntries();
    if (preferences.view === 'details') renderDetails(values);
    else { const grid = node('div', '', 'sales-library-icons'); for (const entry of values) { const tile = node('article', '', 'sales-library-icon' + (entry.kind === 'template' ? ' sales-library-template' : '')); bindEntry(tile, entry); tile.append(moreButton(entry), icon(entry), node('span', entry.title, 'sales-library-icon-name'), node('small', entry.kind === 'folder' ? 'Ordner' : entry.type)); grid.append(tile); } list.append(grid); }
    if (!values.length) list.append(node('p', el('salesReportJobFilter').value ? 'Keine passenden Berichte oder Vorlagen.' : 'Dieser Ordner ist leer. Über „Neuer Ordner“ oder per Rechtsklick kannst du ihn organisieren.'));
  }
  el('salesLibraryNewFolder').addEventListener('click', () => { void newFolder().catch(onError); });
  el('salesLibraryView').addEventListener('change', () => layout({ ...preferences, view: el('salesLibraryView').value }));
  el('salesLibraryFilter').addEventListener('change', render); el('salesReportJobFilter').addEventListener('input', render);
  list.addEventListener('contextmenu', event => { if (!event.target.closest('[data-library-key]')) showMenu(event, { id: current, title: state.folders.find(f => f.id === current)?.title || 'Berichte', type: 'Ordner', kind: 'folder' }, list); });
  list.addEventListener('dragover', event => { if (!event.target.closest('[data-drop-folder]') && [...event.dataTransfer.types].includes('application/x-gp-report-library')) event.preventDefault(); });
  list.addEventListener('drop', event => { if (!event.target.closest('[data-drop-folder]')) performDrop(event, current); });
  menu.addEventListener('keydown', event => { const items = [...menu.querySelectorAll('button')], i = items.indexOf(document.activeElement); if (event.key === 'Escape') { event.preventDefault(); closeMenu(true); } else if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) { event.preventDefault(); items[event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : (i + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length]?.focus(); } });
  document.addEventListener('pointerdown', event => { if (!menu.hidden && !menu.contains(event.target)) closeMenu(); });
  window.addEventListener('scroll', () => { if (!menu.hidden) closeMenu(); }, true); window.addEventListener('resize', () => closeMenu());
  return { render, title, folder: () => current,
    update(nextReports, nextTemplates, nextState) { reports = nextReports; templates = nextTemplates; if (nextState) { state = nextState; try { preferences = Options.normalize(state.preferences); } catch { preferences = Options.defaults(); } } render(); },
    reset() { generation++; dragToken = token(); mutations = Promise.resolve(); busy = false; root.removeAttribute('aria-busy'); current = ''; expanded = new Set(['']); selected = ''; columnsOpen = false; reports = []; templates = []; state = { revision: 0, folders: [], items: [] }; preferences = Options.defaults(); if (dialog.open) dialog.close(); if (el('salesLibraryProperties').open) el('salesLibraryProperties').close(); info(''); render(); },
    async place(item, kind) { if (current && !state.items.some(i => i.id === item.id && i.kind === kind)) await change({ action: 'moveItem', id: item.id, kind, parentId: current }); const saved = metadata(item, kind); if (saved?.title && saved.title !== item.title) await change({ action: 'renameItem', id: item.id, kind, title: item.title }); }
  };
};
