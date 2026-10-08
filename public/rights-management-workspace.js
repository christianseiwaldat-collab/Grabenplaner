(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RightsManagementWorkspace = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const COLUMNS = Object.freeze([
    {id:'employeeNumber', label:'Personalnr.', width:100},
    {id:'name', label:'Name', width:160},
    {id:'role', label:'Rolle', width:130},
    {id:'location', label:'Filiale', width:110},
    {id:'added', label:'Zusatzrechte', width:100, numeric:true},
    {id:'revoked', label:'Entzogen', width:90, numeric:true},
    {id:'status', label:'Zugang', width:120},
    {id:'personnel', label:'Personalakt', width:170},
  ].map(column => Object.freeze(column)));
  const IDS = COLUMNS.map(column => column.id), ID_SET = new Set(IDS);
  const DEFAULT_COLUMNS = IDS.filter(id => id !== 'personnel');
  const ACTION = Object.freeze({id:'actions', label:'Rechteprofil', width:120, resizable:false});
  const storagePrefix = 'grabenplaner:rights-management-table-v1:';
  const plain = value => value && typeof value === 'object' && !Array.isArray(value)
    && [Object.prototype, null].includes(Object.getPrototypeOf(value));
  function normalize(value) {
    const input = plain(value) && value.version === 1 ? value : {};
    const selected = Array.isArray(input.columns) ? input.columns.filter(id => ID_SET.has(id)) : DEFAULT_COLUMNS;
    const requestedOrder = Array.isArray(input.order) ? input.order : selected;
    const order = [...new Set([...requestedOrder.filter(id => ID_SET.has(id)), ...IDS])];
    const included = new Set(['employeeNumber', ...selected]);
    const columnWidths = {};
    if (plain(input.columnWidths)) for (const id of IDS) {
      const width = input.columnWidths[id];
      if (Number.isInteger(width) && width >= 80 && width <= 800) columnWidths[id] = width;
    }
    return {version:1, columns:order.filter(id => included.has(id)), order, columnWidths,
      sort:ID_SET.has(input.sort) ? input.sort : 'employeeNumber', direction:input.direction === 'desc' ? 'desc' : 'asc'};
  }
  function projectRows(users, locations) {
    const locationNames = new Map((Array.isArray(locations) ? locations : []).map(item => [String(item.id), item.name]));
    return (Array.isArray(users) ? users : []).filter(user => user && user.employeeNumber !== undefined).map(user => {
      const levels = Object.values(user.personnelFieldAccess || {});
      const personnel = ['location_planner','manager','department_manager'].includes(user.role) && levels.length
        ? `${levels.filter(level => level === 'read').length} lesen · ${levels.filter(level => level === 'write').length} bearbeiten` : '–';
      return {employeeNumber:String(user.employeeNumber), name:String(user.nickname || user.fullName || '–'), fullName:String(user.fullName || ''),
        role:String(user.roleName || user.role || '–'), location:String(locationNames.get(String(user.homeLocationId)) || user.homeLocationId || 'Kein Standort'),
        added:Array.isArray(user.grantedPermissions) ? user.grantedPermissions.length : 0,
        revoked:Array.isArray(user.deniedPermissions) ? user.deniedPermissions.length : 0,
        status:!user.configured ? 'Noch nicht eingerichtet' : !user.active ? 'Inaktiv' : user.manageable ? 'Bearbeitbar' : 'Nur Ansicht',
        personnel, manageable:user.manageable === true};
    });
  }
  function sortRows(rows, preferences, query = '') {
    const prefs = normalize(preferences), term = String(query).trim().toLocaleLowerCase('de-AT');
    const column = COLUMNS.find(item => item.id === prefs.sort);
    return rows.filter(row => !term || ['employeeNumber','name','fullName','role','location']
      .some(id => String(row[id] || '').toLocaleLowerCase('de-AT').includes(term))).sort((left, right) => {
        const a = left[prefs.sort], b = right[prefs.sort];
        const compared = column.numeric ? Number(a) - Number(b)
          : String(a ?? '').localeCompare(String(b ?? ''), 'de-AT', {numeric:true, sensitivity:'base'});
        return compared ? compared * (prefs.direction === 'desc' ? -1 : 1)
          : String(left.employeeNumber).localeCompare(String(right.employeeNumber), 'de-AT', {numeric:true});
      });
  }
  function shortProfileTitle(profile = {}) {
    const number = String(profile.employeeNumber || '').trim();
    // Never infer a given name from fullName: imported names can be surname-first.
    const name = [profile.firstName,profile.nickname,profile.fullName]
      .map(value => String(value || '').trim()).find(Boolean) || '';
    return [number,name].filter(Boolean).join(' · ');
  }
  function mount(options) {
    const root = options.root, editor = options.editor;
    if (!root || !editor) return null;
    const doc = options.document || root.ownerDocument, win = doc.defaultView;
    const q = selector => root.querySelector(selector), listeners = [];
    const on = (target, name, callback) => {target?.addEventListener(name, callback); listeners.push(() => target?.removeEventListener(name, callback));};
    const element = (tag, text, className) => {
      const node = doc.createElement(tag);
      if (text !== undefined) node.textContent = String(text);
      if (className) node.className = className;
      return node;
    };
    const roster = q('#rightsUserList'), query = q('#rightsEmployeeSearch'), hint = q('#rightsManagementHint');
    const chooser = q('[data-rights-column-options]');
    const tableScroll = element('div', undefined, 'rights-management-table-scroll');
    const table = element('table', undefined, 'rights-management-table');
    table.setAttribute('aria-label', 'Teammitglieder im Rechtemanagement');
    const head = element('thead'), body = element('tbody');table.append(head, body);tableScroll.append(table);roster?.replaceChildren(tableScroll);
    root.hidden = true;root.dataset.gpWindowManual = '';editor.dataset.gpWindowManual = '';
    root.classList.add('rights-management-window');editor.classList.add('rights-profile-window');
    let actor = '', identity = '', epoch = 0, destroyed = false, rows = [], managerDenialOnly = false;
    let prefs = normalize(null), mainWindow = null, profileWindow = null, layout = null;
    let mainOpen = false, profileOpen = false, profileOpener = null, profileEmployeeNumber = '', profileShortTitle = '';
    let mainActivated = false, profileActivated = false, mainClosing = false, profileClosing = false;
    let mainRestoreOnActivate = false, mainMinimizeOnActivate = false, profileRestoreOnActivate = false;
    const key = () => String(options.key?.() || '');
    const stableIdentity = () => String(options.identity?.() || key());
    const allowed = () => !destroyed && Boolean(actor) && actor === key() && Boolean(options.canUse?.());
    const active = () => allowed() && options.active?.() !== false;
    const selected = () => [...prefs.columns.map(id => COLUMNS.find(column => column.id === id)), ACTION];
    function storage() {return options.storage || win.localStorage;}
    function metadataKey() {return storagePrefix + encodeURIComponent(identity);}
    function loadMetadata() {
      prefs = normalize(null);
      if (!identity) return;
      try {const raw = storage().getItem(metadataKey());if (raw && raw.length <= 12000) prefs = normalize(JSON.parse(raw));}
      catch { /* A restricted browser keeps the current session usable. */ }
    }
    function persist() {
      if (!allowed() || !identity) return;
      prefs = normalize(prefs);
      try {storage().setItem(metadataKey(), JSON.stringify(prefs));}
      catch (error) {options.error?.(error);}
    }
    function defaultGeometry(profile = false) {
      if (!profile && options.initialGeometry) return options.initialGeometry();
      const bounds = options.bounds?.() || win.GpWindow.viewportBounds(win.visualViewport || {width:win.innerWidth,height:win.innerHeight}, options.scale?.() || 1);
      const width = Math.min(profile ? 700 : 1000, bounds.width);
      return {x:Math.max(0, Math.round((bounds.width - width) / 2)), y:Math.min(80, Math.max(0, bounds.height - 180)), width,
        height:Math.min(profile ? 640 : 500, bounds.height), minimized:false};
    }
    function clearProfile() {
      editor.querySelector('#rightsEditorPermissions')?.replaceChildren();
      for (const id of ['rightsEditorTitle','rightsEditorSummary','rightsEditorHint','rightsEditorAnnouncement']) {
        const node = editor.querySelector('#' + id);if (node) node.textContent = '';
      }
      for (const input of editor.querySelectorAll('input')) {if (['checkbox','radio'].includes(input.type)) input.checked = false;}
      const save = editor.querySelector('#saveRightsEditorButton');if (save) save.disabled = true;
    }
    function synchronize() {
      const next = key(), nextIdentity = stableIdentity();
      if (next === actor && nextIdentity === identity && options.canUse?.()) return;
      epoch++;actor = next;identity = nextIdentity;rows = [];managerDenialOnly = false;mainOpen = false;profileOpen = false;profileOpener = null;profileEmployeeNumber = '';profileShortTitle = '';
      mainActivated = false;profileActivated = false;mainClosing = false;profileClosing = false;
      mainWindow?.destroy();mainWindow = null;profileWindow?.destroy();profileWindow = null;
      if (editor.open) editor.close();editor.hidden = true;root.hidden = true;clearProfile();
      if (query) query.value = '';
      loadMetadata();renderRows();
    }
    function renderChooser() {
      if (!chooser) return;
      chooser.replaceChildren();
      for (const id of prefs.order) {
        const column = COLUMNS.find(item => item.id === id), entry = element('div', undefined, 'rights-management-column-option');
        const label = element('label'), input = element('input');input.type = 'checkbox';input.dataset.rightsColumn = id;
        input.checked = prefs.columns.includes(id);input.disabled = id === 'employeeNumber' || !active();
        label.append(input, element('span', column.label));entry.append(label);
        for (const [direction, symbol] of [[-1,'←'],[1,'→']]) {
          const button = element('button', symbol);button.type = 'button';button.dataset.rightsColumnMove = id;button.dataset.direction = String(direction);
          button.setAttribute('aria-label', column.label + (direction < 0 ? ' nach links' : ' nach rechts'));
          const index = prefs.order.indexOf(id);button.disabled = !active() || index + direction < 0 || index + direction >= prefs.order.length;
          entry.append(button);
        }
        chooser.append(entry);
      }
    }
    function renderRows() {
      const focused = doc.activeElement;
      let focusTarget = null;
      if (root.contains(focused)) for (const attribute of ['data-rights-sort','data-rights-column','data-rights-column-move','data-gp-column-resize']) {
        if (focused.hasAttribute?.(attribute)) {focusTarget = {attribute, value:focused.getAttribute(attribute), direction:focused.dataset.direction};break;}
      }
      // Reattach after legacy error/logout paths clear the host. The table and
      // its resize controller retain one owner throughout the workspace life.
      if (roster && !roster.contains(tableScroll)) roster.replaceChildren(tableScroll);
      const columns = selected();head.replaceChildren();body.replaceChildren();
      const headerRow = element('tr');head.append(headerRow);
      for (const column of columns) {
        const th = element('th');th.scope = 'col';
        if (column.id === 'actions') {th.textContent = column.label;th.classList.add('rights-management-actions');}
        else {
          th.setAttribute('aria-sort', prefs.sort === column.id ? prefs.direction === 'desc' ? 'descending' : 'ascending' : 'none');
          const button = element('button', column.label);button.type = 'button';button.dataset.rightsSort = column.id;button.disabled = !active();
          const resize = element('button', '');resize.type = 'button';resize.dataset.gpColumnResize = column.id;
          resize.setAttribute('aria-label', column.label + ': Spaltenbreite ändern');th.append(button, resize);
        }
        headerRow.append(th);
      }
      const visible = allowed() ? sortRows(rows, prefs, query?.value) : [];
      for (const row of visible) {
        const tr = element('tr');tr.dataset.rightsUser = row.employeeNumber;
        for (const column of columns) {
          const td = element('td');
          if (column.id === 'actions') {
            td.classList.add('rights-management-actions');
            const button = element('button', row.manageable ? 'Bearbeiten' : 'Ansehen', 'secondary-button');button.type = 'button';button.dataset.editUserRights = '';
            button.setAttribute('aria-label', (row.manageable ? 'Rechte bearbeiten: ' : 'Rechte ansehen: ') + row.name);button.disabled = !active();td.append(button);
          } else {
            td.textContent = String(row[column.id]);
            if (column.numeric) td.classList.add('is-number');
            if (column.id === 'status') {const badge = element('span', row.status, 'rights-management-status');td.replaceChildren(badge);}
          }
          tr.append(td);
        }
        body.append(tr);
      }
      if (!visible.length) {
        const tr = element('tr'), td = element('td', allowed() && rows.length ? 'Kein Teammitglied entspricht dieser Suche.' : 'Noch keine Teammitglieder geladen.', 'rights-management-empty');
        td.colSpan = columns.length;tr.append(td);body.append(tr);
      }
      if (hint) hint.textContent = !allowed() ? 'Rechtemanagement ist für diesen Zugang nicht verfügbar.'
        : `${visible.length} von ${rows.length} Teammitgliedern${managerDenialOnly ? ' im eigenen Standort' : ''} angezeigt.`;
      renderChooser();layout?.render();
      if (focusTarget && active() && !root.hidden) {
        const target = [...root.querySelectorAll('[' + focusTarget.attribute + ']')]
          .find(node => node.getAttribute(focusTarget.attribute) === focusTarget.value && node.dataset.direction === focusTarget.direction);
        if (target && !target.disabled) target.focus({preventScroll:true});
        else query?.focus({preventScroll:true});
      }
    }
    function currentProfileOpener() {
      if (profileOpener?.isConnected) return profileOpener;
      const row = [...root.querySelectorAll('[data-rights-user]')].find(node => node.dataset.rightsUser === profileEmployeeNumber);
      return row?.querySelector('[data-edit-user-rights]') || options.opener;
    }
    function attachMain() {
      if (mainWindow) return;
      mainWindow = win.GpWindow.attach(root, {title:q('[data-rights-window-title]'),body:q('[data-rights-window-body]'),
        toggle:q('[data-rights-window-toggle]'),bounds:options.bounds,scale:options.scale,
        geometry:options.windowPreferences?.value.windows['rights:management'] || defaultGeometry(),minWidth:300,minHeight:180,compactWidth:260,
        canUse:active,change:geometry => options.windowPreferences?.change('rights:management', geometry),closeTarget:() => options.closeTarget?.() || options.opener,
        onClose() {mainOpen = false;mainActivated = false;root.hidden = true;options.opener?.setAttribute('aria-expanded','false');}});
    }
    function attachProfile() {
      if (profileWindow) return;
      profileWindow = win.GpWindow.attach(editor, {nativeDialog:true,title:editor.querySelector('[data-rights-profile-window-title]'),body:editor.querySelector('#rightsEditorForm'),
        toggle:editor.querySelector('[data-rights-profile-window-toggle]'),bounds:options.bounds,scale:options.scale,
        geometry:options.windowPreferences?.value.windows['rights:profile'] || defaultGeometry(true),minWidth:300,minHeight:200,compactWidth:260,
        minimizedTitle:() => profileShortTitle,
        canUse:() => active() && editor.open,change:geometry => options.windowPreferences?.change('rights:profile',geometry),closeTarget:currentProfileOpener,
        onClose() {profileOpen = false;profileActivated = false;editor.close();}});
    }
    async function show(intent = {}) {
      synchronize();if (!active()) return false;
      const ticket = epoch;mainOpen = true;mainMinimizeOnActivate = intent.minimized === true;mainRestoreOnActivate = !mainMinimizeOnActivate && intent.restore !== false;await options.windowPreferences?.activate();
      if (!allowed() || ticket !== epoch || !mainOpen) return false;
      attachMain();if (!active()) {mainWindow.suspend();mainActivated = false;return false;}
      mainWindow.activate();mainActivated = true;if (mainMinimizeOnActivate) mainWindow.minimize(true);else if (mainRestoreOnActivate) mainWindow.restore();mainRestoreOnActivate = false;mainMinimizeOnActivate = false;options.opener?.setAttribute('aria-expanded','true');renderRows();
      if (!mainWindow.preferred.minimized) query?.focus({preventScroll:true});return true;
    }
    async function showProfile(opener, profile = {}) {
      synchronize();if (!active()) return false;
      const summary = editor.querySelector('#rightsEditorTitle')?.textContent || '';
      const parts = summary.split('·');
      profileShortTitle = shortProfileTitle(profile) || shortProfileTitle({employeeNumber:parts[0],firstName:parts.slice(1).join('·')});
      const ticket = epoch;profileOpener = opener || doc.activeElement;profileOpen = true;profileRestoreOnActivate = true;
      profileEmployeeNumber = profileOpener?.closest?.('[data-rights-user]')?.dataset.rightsUser || profileEmployeeNumber;
      await options.windowPreferences?.activate();if (!allowed() || ticket !== epoch || !profileOpen) return false;
      editor.hidden = !active();if (!editor.open) editor.show();attachProfile();if (!active()) {profileWindow.suspend();profileActivated = false;return false;}
      profileWindow.activate();profileActivated = true;profileWindow.restore();profileRestoreOnActivate = false;
      editor.querySelector('#rightsEditorTitle')?.focus({preventScroll:true});return true;
    }
    async function closeMain() {
      if (!mainOpen || !active() || mainClosing) return;
      mainOpen = false;mainClosing = true;try {await mainWindow?.close();} finally {mainClosing = false;}
    }
    async function closeProfile() {
      if (!profileOpen || !active() || profileClosing) return;
      profileOpen = false;profileClosing = true;try {await profileWindow?.close();} finally {profileClosing = false;}
    }
    const unsubscribe = options.windowPreferences?.subscribe(value => {
      if (!allowed()) return;
      if (value.windows['rights:management']) mainWindow?.set(value.windows['rights:management']);
      if (value.windows['rights:profile']) profileWindow?.set(value.windows['rights:profile']);
    });
    on(query,'input',renderRows);
    on(options.opener,'click',() => void show());
    on(q('[data-rights-window-close]'),'click',() => void closeMain());
    on(editor.querySelector('[data-rights-profile-window-close]'),'click',() => void closeProfile());
    on(editor,'close',() => {profileOpen = false;profileActivated = false;profileWindow?.suspend();});
    on(editor,'cancel',event => {event.preventDefault();void closeProfile();});
    on(editor,'keydown',event => {
      if (event.key !== 'Escape' || event.defaultPrevented || !active() || !editor.open
        || editor.classList.contains('is-moving') || editor.classList.contains('is-resizing')) return;
      event.preventDefault();event.stopPropagation();void closeProfile();
    });
    on(root,'click',event => {
      if (!active()) return;
      const button = event.target.closest('button');if (!button || button.disabled) return;
      if (button.hasAttribute('data-edit-user-rights')) {
        const number = button.closest('[data-rights-user]')?.dataset.rightsUser;
        if (rows.some(row => row.employeeNumber === number)) {profileOpener = button;profileEmployeeNumber = number;options.openProfile?.(number,button);}
      } else if (button.dataset.rightsSort && ID_SET.has(button.dataset.rightsSort)) {
        const sort = button.dataset.rightsSort;prefs = normalize({...prefs,sort,direction:prefs.sort === sort && prefs.direction === 'asc' ? 'desc' : 'asc'});renderRows();persist();
      } else if (button.dataset.rightsColumnMove) {
        const order = [...prefs.order], index = order.indexOf(button.dataset.rightsColumnMove), next = index + Number(button.dataset.direction);
        if (index >= 0 && next >= 0 && next < order.length) {[order[index],order[next]] = [order[next],order[index]];prefs = normalize({...prefs,order});renderRows();persist();}
      }
    });
    on(chooser,'change',event => {
      const id = event.target.dataset.rightsColumn;if (!active() || !ID_SET.has(id)) return;
      const columns = event.target.checked ? [...prefs.columns,id] : prefs.columns.filter(value => value !== id);
      prefs = normalize({...prefs,columns});renderRows();persist();
    });
    layout = win.GrabenplanerTableLayout?.attach(table,{columns:selected,widths:() => prefs.columnWidths,
      allowedColumns:() => IDS,canResize:active,change:columnWidths => {if (active()) prefs = normalize({...prefs,columnWidths});},persist});
    synchronize();
    return {show,showProfile,render(value = {}) {
      synchronize();if (!allowed()) return;
      rows = projectRows(value.users,value.locations);managerDenialOnly = value.managerDenialOnly === true;renderRows();
    },sync() {
      synchronize();if (!active()) {mainWindow?.suspend();profileWindow?.suspend();mainActivated = false;profileActivated = false;root.hidden = true;editor.hidden = true;}
      else {
        if (mainOpen && mainWindow && !mainActivated) {mainWindow.activate();mainActivated = true;if (mainMinimizeOnActivate) mainWindow.minimize(true);else if (mainRestoreOnActivate) mainWindow.restore();mainRestoreOnActivate = false;mainMinimizeOnActivate = false;options.opener?.setAttribute('aria-expanded','true');}
        if (profileOpen && editor.open && !profileActivated) {editor.hidden = false;profileWindow?.activate();profileActivated = true;if (profileRestoreOnActivate) profileWindow?.restore();profileRestoreOnActivate = false;}
        if (mainOpen && mainActivated && !mainClosing && !root.matches('.is-moving,.is-resizing')) mainWindow?.refresh();
        if (profileOpen && profileActivated && !profileClosing && !editor.matches('.is-moving,.is-resizing')) profileWindow?.refresh();
      }
      renderRows();
    },suspend() {mainWindow?.suspend();profileWindow?.suspend();mainActivated = false;profileActivated = false;root.hidden = true;editor.hidden = true;},
    destroy() {destroyed = true;epoch++;unsubscribe?.();for (const remove of listeners) remove();mainWindow?.destroy();profileWindow?.destroy();layout?.destroy();
      rows = [];if (editor.open) editor.close();editor.hidden = true;clearProfile();roster?.replaceChildren();root.hidden = true;},
    get preferences() {return normalize(prefs);}};
  }
  return Object.freeze({COLUMNS,normalize,projectRows,sortRows,shortProfileTitle,mount});
});
