(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.RightsSettingsTable = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const PREFIX = 'grabenplaner:rights-settings-table-v1:';
  function normalize(value, columns) {
    const ids = columns.map(column => column.id), allowed = new Set(ids);
    const input = value && typeof value === 'object' && !Array.isArray(value) && value.version === 1 ? value : {};
    const order = [...new Set([...(Array.isArray(input.order) ? input.order : []).filter(id => allowed.has(id)), ...ids])];
    const visible = new Set(Array.isArray(input.columns) ? input.columns.filter(id => allowed.has(id)) : columns.filter(column => column.visible !== false).map(column => column.id));
    columns.filter(column => column.mandatory).forEach(column => visible.add(column.id));
    if (!visible.size && ids.length) visible.add(ids[0]);
    const columnWidths = {};
    for (const id of ids) {
      const width = input.columnWidths?.[id];
      if (Number.isInteger(width) && width >= 80 && width <= 800) columnWidths[id] = width;
    }
    return {version:1, order, columns:order.filter(id => visible.has(id)), columnWidths,
      sort:allowed.has(input.sort) ? input.sort : columns.find(column => column.sortable !== false)?.id || ids[0], direction:input.direction === 'desc' ? 'desc' : 'asc'};
  }
  function mount(options) {
    const host = options.host;
    if (!host) return null;
    const doc = host.ownerDocument, win = doc.defaultView, specs = options.columns;
    const listeners = [];
    const on = (target, name, callback) => {target?.addEventListener(name,callback);listeners.push(() => target?.removeEventListener(name,callback));};
    const node = (tag,text,className) => {const element = doc.createElement(tag);if (text !== undefined) element.textContent = String(text);if (className) element.className = className;return element;};
    const workspace = node('div',undefined,'rights-settings-table-workspace');
    const toolbar = node('div',undefined,'rights-table-toolbar');
    const search = options.searchInput || node('input');
    if (!options.searchInput) {
      const label = node('label',undefined,'field rights-table-search');
      search.type = 'search';search.autocomplete = 'off';search.placeholder = options.searchLabel || 'In dieser Tabelle suchen';
      label.append(node('span',options.searchLabel || 'Suchen'),search);toolbar.append(label);
    }
    const chooser = node('details',undefined,'rights-table-columns'), choices = node('div',undefined,'rights-table-column-options');
    chooser.append(node('summary','Spaltenansicht'),choices);toolbar.append(chooser);
    const count = node('p','', 'settings-note rights-table-count');count.setAttribute('aria-live','polite');
    const scroll = node('div',undefined,'rights-table-scroll'), table = node('table',undefined,'rights-settings-table');
    table.setAttribute('aria-label',options.label || options.tableId);
    const head = node('thead'), body = node('tbody');table.append(head,body);scroll.append(table);
    workspace.append(toolbar,count,scroll);host.replaceChildren(workspace);
    let rows = [], identity = null, destroyed = false, prefs = normalize(null,specs), layout = null;
    const allowed = () => !destroyed && options.canUse?.() !== false;
    const storage = () => options.storage || win.localStorage;
    const metadataKey = () => PREFIX + encodeURIComponent(options.tableId) + ':' + encodeURIComponent(identity);
    const selected = () => prefs.columns.map(id => specs.find(column => column.id === id));
    function syncIdentity() {
      const next = String(typeof options.identity === 'function' ? options.identity() : options.identity || 'local');
      if (next === identity) return;
      identity = next;rows = [];search.value = '';prefs = normalize(null,specs);
      try {const raw = storage().getItem(metadataKey());if (raw && raw.length <= 16000) prefs = normalize(JSON.parse(raw),specs);} catch { /* Session use remains possible if storage is unavailable. */ }
    }
    function persist() {
      if (!allowed()) return;
      try {storage().setItem(metadataKey(),JSON.stringify(normalize(prefs,specs)));} catch (error) {options.error?.(error);}
    }
    function sortValue(row,column) {return column.sortValue ? column.sortValue(row) : row[column.id] ?? '';}
    function render() {
      syncIdentity();
      if (!host.contains(workspace)) host.replaceChildren(workspace);
      const focused = doc.activeElement;
      const focus = workspace.contains(focused) ? ['data-rights-table-sort','data-rights-table-column','data-rights-table-move','data-gp-column-resize'].map(attribute => ({attribute,value:focused.getAttribute?.(attribute),direction:focused.dataset.direction})).find(value => value.value !== null) : null;
      choices.replaceChildren();
      for (const id of prefs.order) {
        const column = specs.find(item => item.id === id), entry = node('div',undefined,'rights-table-column-option'), label = node('label'), input = node('input');
        input.type = 'checkbox';input.dataset.rightsTableColumn = id;input.checked = prefs.columns.includes(id);
        input.disabled = !allowed() || column.mandatory || (input.checked && prefs.columns.length === 1);
        label.append(input,node('span',column.label));entry.append(label);
        for (const [direction,symbol] of [[-1,'←'],[1,'→']]) {
          const button = node('button',symbol);button.type='button';button.dataset.rightsTableMove=id;button.dataset.direction=String(direction);
          button.setAttribute('aria-label',column.label + (direction < 0 ? ' nach links' : ' nach rechts'));
          const index=prefs.order.indexOf(id);button.disabled=!allowed()||index+direction<0||index+direction>=prefs.order.length;entry.append(button);
        }
        choices.append(entry);
      }
      head.replaceChildren();body.replaceChildren();
      const columns = selected(), header = node('tr');head.append(header);
      for (const column of columns) {
        const th=node('th');th.scope='col';th.dataset.rightsTableColumnId=column.id;
        th.setAttribute('aria-sort',prefs.sort===column.id ? prefs.direction==='desc'?'descending':'ascending' : 'none');
        const sort=node('button',column.label);sort.type='button';sort.dataset.rightsTableSort=column.id;sort.disabled=!allowed()||column.sortable===false;
        const resize=node('button');resize.type='button';resize.dataset.gpColumnResize=column.id;resize.setAttribute('aria-label',column.label+': Spaltenbreite ändern');th.append(sort,resize);header.append(th);
      }
      const query=search.value.trim().toLocaleLowerCase('de-AT'), sort=specs.find(column=>column.id===prefs.sort);
      const displayed=allowed() ? rows.filter(row=>!query||String(options.searchText ? options.searchText(row) : specs.map(column=>sortValue(row,column)).join(' ')).toLocaleLowerCase('de-AT').includes(query)).slice().sort((a,b)=>{
        const left=sortValue(a,sort),right=sortValue(b,sort);
        const compared=sort.numeric ? Number(left)-Number(right) : String(left).localeCompare(String(right),'de-AT',{numeric:true,sensitivity:'base'});
        return compared*(prefs.direction==='desc'?-1:1);
      }) : [];
      for (const row of displayed) {
        const tr=node('tr');if(row.id!==undefined)tr.dataset.rightsTableRow=String(row.id);
        for(const column of columns){const td=node('td');td.dataset.rightsTableCell=column.id;const content=column.cell?.(row,doc);if(content?.nodeType)td.append(content);else td.textContent=String(content??row[column.id]??'');tr.append(td);}body.append(tr);
      }
      if(!displayed.length){const tr=node('tr'),td=node('td',query?'Keine passenden Einträge.':options.emptyText||'Noch keine Einträge geladen.','rights-table-empty');td.colSpan=columns.length;tr.append(td);body.append(tr);}
      count.textContent=`${displayed.length} von ${rows.length} Einträgen angezeigt.`;
      layout?.render();
      if(focus){const target=[...workspace.querySelectorAll('['+focus.attribute+']')].find(element=>element.getAttribute(focus.attribute)===focus.value&&element.dataset.direction===focus.direction);if(target&&!target.disabled)target.focus({preventScroll:true});}
    }
    on(search,'input',render);
    on(workspace,'click',event=>{
      const button=event.target.closest('button');if(!allowed()||!button||button.disabled)return;
      if(button.dataset.rightsTableSort){const id=button.dataset.rightsTableSort;prefs=normalize({...prefs,sort:id,direction:prefs.sort===id&&prefs.direction==='asc'?'desc':'asc'},specs);render();persist();}
      else if(button.dataset.rightsTableMove){const order=[...prefs.order],index=order.indexOf(button.dataset.rightsTableMove),next=index+Number(button.dataset.direction);if(index>=0&&next>=0&&next<order.length){[order[index],order[next]]=[order[next],order[index]];prefs=normalize({...prefs,order},specs);render();persist();}}
    });
    on(choices,'change',event=>{const id=event.target.dataset.rightsTableColumn;if(!allowed()||!specs.some(column=>column.id===id))return;const columns=event.target.checked?[...prefs.columns,id]:prefs.columns.filter(value=>value!==id);prefs=normalize({...prefs,columns},specs);render();persist();});
    layout=win.GrabenplanerTableLayout?.attach(table,{columns:selected,widths:()=>prefs.columnWidths,allowedColumns:()=>specs.map(column=>column.id),canResize:allowed,change:columnWidths=>{prefs=normalize({...prefs,columnWidths},specs);},persist});
    syncIdentity();rows=allowed()&&Array.isArray(options.rows)?options.rows:[];render();
    return {setRows(value){syncIdentity();rows=allowed()&&Array.isArray(value)?value:[];render();},refresh:render,
      get rows(){return [...rows];},get preferences(){return normalize(prefs,specs);},
      destroy(){destroyed=true;listeners.forEach(remove=>remove());layout?.destroy();rows=[];host.replaceChildren();}};
  }
  return Object.freeze({normalize,mount});
});
