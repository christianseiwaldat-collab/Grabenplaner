(function(root,factory) {
  const value=factory();
  if(typeof module==='object' && module.exports) module.exports=value;
  else root.SalesArticleStockPanel=value;
})(typeof window==='object' ? window : this,function() {
  'use strict';
  function mount(host,{store,stock,formats,layout,tableLayout,columns,canUse}) {
    let table=null,destroyed=false;
    const win=host.ownerDocument.defaultView;
    const usable=()=>!destroyed && canUse();
    const writable=()=>usable() && store.ready;
    function render() {
      table?.destroy();table=null;
      if(!usable()) {host.hidden=true;host.replaceChildren();return;}
      const chooser=host.querySelector('[data-stock-settings]'),open=Boolean(chooser?.open);
      const focused=host.ownerDocument.activeElement,focusId=host.contains(focused)
        ? ['data-stock-branch','data-stock-column','data-stock-sort','data-stock-all','data-stock-preferences-retry'].find(name=>focused.hasAttribute(name)) : null;
      const focusChooser=Boolean(focused && focused===host.querySelector('[data-stock-settings] > summary'));
      const focusValue=focusId ? focused.getAttribute(focusId) : null;
      let markup=layout.branchStock(stock,formats,store.value);
      if(!store.ready) {
        const status=store.failed
          ? '<p class="sales-article-detail-message" role="alert">Ansichtseinstellungen konnten nicht geladen werden. <button type="button" data-stock-preferences-retry>Einstellungen erneut laden</button></p>'
          : '<p class="sales-article-detail-message" role="status">Ansichtseinstellungen werden geladen…</p>';
        markup=markup.replace('</header>','</header>'+status);
      }
      host.hidden=false;host.innerHTML=markup;
      for(const attribute of ['data-stock-branch','data-stock-column','data-stock-sort','data-stock-all']) {
        for(const control of host.querySelectorAll('['+attribute+']')) control.disabled ||= !store.ready;
      }
      const nextChooser=host.querySelector('[data-stock-settings]');if(nextChooser) nextChooser.open=open;
      const target=focusId && [...host.querySelectorAll('['+focusId+']')].find(node=>node.getAttribute(focusId)===focusValue);
      target?.focus({preventScroll:true});
      if(focusChooser || (focusId==='data-stock-preferences-retry' && !target)) host.querySelector('[data-stock-settings] > summary')?.focus({preventScroll:true});
      table=tableLayout.attach(host.querySelector('table'),{
        columns:()=>store.value.columns.map(id=>columns.find(column=>column.id===id)),
        widths:()=>store.value.columnWidths,allowedColumns:()=>columns.map(column=>column.id),canResize:writable,
        change:columnWidths=>{if(writable()) store.change({...store.value,columnWidths},{publish:false});},persist:()=>{if(writable()) void store.save();},
      });
    }
    function update(next) {if(!writable()) return;if(store.change(next)) void store.save();}
    function change(event) {
      if(!writable()) return;
      const branch=event.target.closest('[data-stock-branch]'),column=event.target.closest('[data-stock-column]'),value=store.value;
      if(branch) {
        const id=branch.getAttribute('data-stock-branch');
        if(!(stock?.rows || []).some(row=>row.id===id)) return;
        update({...value,hiddenBranchIds:branch.checked ? value.hiddenBranchIds.filter(existing=>existing!==id) : [...new Set([...value.hiddenBranchIds,id])]});
      } else if(column) {
        const id=column.getAttribute('data-stock-column');if(!columns.some(item=>item.id===id)) return;
        const selected=column.checked ? columns.filter(item=>item.id===id || value.columns.includes(item.id)).map(item=>item.id) : value.columns.filter(existing=>existing!==id);
        if(!selected.length) {column.checked=true;return;}
        update({...value,columns:selected,sort:selected.includes(value.sort)?value.sort:selected[0]});
      }
    }
    function click(event) {
      if(!usable()) return;
      if(event.target.closest('[data-stock-preferences-retry]')) {if(store.failed) void store.activate({retry:true});return;}
      if(!writable()) return;
      const sort=event.target.closest('[data-stock-sort]'),all=event.target.closest('[data-stock-all]'),value=store.value;
      if(sort) {
        const id=sort.getAttribute('data-stock-sort');if(!value.columns.includes(id)) return;
        update({...value,sort:id,direction:value.sort===id && value.direction==='asc'?'desc':'asc'});
      } else if(all) update({...value,hiddenBranchIds:[]});
    }
    function positionNote(event) {
      const disclosure=event.target;
      if(!disclosure.matches?.('.sales-article-branch-orders') || !disclosure.open) return;
      if(!usable()) {disclosure.open=false;return;}
      for(const other of host.querySelectorAll('.sales-article-branch-orders[open]')) if(other!==disclosure) other.open=false;
      const note=disclosure.querySelector('.sales-article-branch-orders-note'),anchor=disclosure.querySelector('summary').getBoundingClientRect();
      const scale=Number.parseFloat(win.getComputedStyle(host.ownerDocument.body).zoom) || 1;
      const view=win.visualViewport, left=(view?.offsetLeft || 0)/scale, top=(view?.offsetTop || 0)/scale;
      const width=(view?.width || win.innerWidth)/scale,height=(view?.height || win.innerHeight)/scale;
      const noteWidth=Math.min(320,width-16),noteHeight=Math.min(260,height-16);
      note.style.width=noteWidth+'px';note.style.maxHeight=noteHeight+'px';
      note.style.left=Math.max(left+8,Math.min(anchor.right/scale-noteWidth,left+width-noteWidth-8))+'px';
      note.style.top=Math.max(top+8,Math.min(anchor.bottom/scale+4,top+height-noteHeight-8))+'px';
    }
    function closeNotes(event) {
      // Scrolling a note itself must remain possible. Moving its anchor closes it.
      if(event?.target?.closest?.('.sales-article-branch-orders-note')) return;
      for(const disclosure of host.querySelectorAll('.sales-article-branch-orders[open]')) disclosure.open=false;
    }
    function keydown(event) {if(event.key==='Escape') closeNotes();}
    host.addEventListener('change',change);host.addEventListener('click',click);
    host.addEventListener('toggle',positionNote,true);host.addEventListener('keydown',keydown);
    win.addEventListener('resize',closeNotes);win.addEventListener('scroll',closeNotes,true);
    win.visualViewport?.addEventListener('resize',closeNotes);win.visualViewport?.addEventListener('scroll',closeNotes);
    const unsubscribe=store.subscribe(render);render();
    return {render,destroy(){destroyed=true;unsubscribe();table?.destroy();table=null;
      host.removeEventListener('change',change);host.removeEventListener('click',click);host.removeEventListener('toggle',positionNote,true);host.removeEventListener('keydown',keydown);
      win.removeEventListener('resize',closeNotes);win.removeEventListener('scroll',closeNotes,true);
      win.visualViewport?.removeEventListener('resize',closeNotes);win.visualViewport?.removeEventListener('scroll',closeNotes);}};
  }
  return {mount};
});
