(function(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabenplanerTableLayout = api;
})(typeof window === 'object' ? window : this, function() {
  'use strict';
  const MIN = 80, MAX = 800;
  const clamp = value => Math.min(MAX, Math.max(MIN, Math.round(value)));
  function normalize(input, ids = Object.keys(input || {})) {
    if (!input || typeof input !== 'object' || Array.isArray(input)) return {};
    return Object.fromEntries(ids.filter(id => Object.hasOwn(input, id) && typeof input[id] === 'number' && Number.isFinite(input[id]))
      .map(id => [id, clamp(input[id])]));
  }
  function valid(input, ids = Object.keys(input || {})) {
    return input !== null && typeof input === 'object' && !Array.isArray(input)
      && Object.entries(input).every(([id, width]) => ids.includes(id) && Number.isInteger(width) && width >= MIN && width <= MAX);
  }
  function attach(table, options) {
    if (!table) return null;
    let drag = null;
    const attribute = options.resizeAttribute || "data-gp-column-resize", selector = "[" + attribute + "]";
    const listeners = [];
    const on = (type, listener) => { table.addEventListener(type, listener); listeners.push(() => table.removeEventListener(type, listener)); };
    table.classList.add("gp-table-columns");
    let group = table.querySelector('colgroup');
    if (!group) { group = table.ownerDocument.createElement('colgroup'); table.insertBefore(group, table.querySelector('thead')); }
    const columns = () => options.columns();
    const widths = () => normalize(options.widths(), options.allowedColumns?.() || columns().filter(c => c.resizable !== false).map(c => c.id));
    function render() {
      const selected = columns(), saved = widths(), sizes = selected.map(c => saved[c.id] || c.width || options.defaults?.[c.id] || 150);
      if (!selected.some(c => saved[c.id])) {
        const flexible = selected.findIndex(c => c.id === 'description');
        if (flexible >= 0) sizes[flexible] = clamp(sizes[flexible] + Math.max(0, table.parentElement.clientWidth - sizes.reduce((sum, w) => sum + w, 0)));
      }
      const ids = selected.map(c => c.id).join('|');
      if (group.dataset.columns !== ids) {
        group.replaceChildren(...selected.map(c => { const col = table.ownerDocument.createElement('col'); col.dataset.column = c.id; return col; }));
        group.dataset.columns = ids;
      }
      [...group.children].forEach((col, i) => { col.style.width = sizes[i] + 'px'; });
      table.style.width = sizes.reduce((sum, width) => sum + width, 0) + 'px';
      for (const handle of table.querySelectorAll(selector)) {
        const index = selected.findIndex(c => c.id === handle.getAttribute(attribute));
        const width = sizes[index] || MIN;
        handle.setAttribute('aria-valuenow', String(Math.round(width)));
        handle.setAttribute('aria-valuetext', Math.round(width) + ' Pixel');
        handle.disabled = !options.canResize();
      }
    }
    function measured() {
      const result = widths();
      [...table.tHead.rows[0].cells].forEach((cell, i) => { if (columns()[i].resizable !== false) result[columns()[i].id] = clamp(cell.getBoundingClientRect().width); });
      return result;
    }
    function resize(id, width, baseline) {
      options.change({...baseline, [id]:clamp(width)});
      render();
    }
    on('pointerdown', event => {
      const handle = event.target.closest(selector);
      if (!handle || event.button !== 0 || !options.canResize()) return;
      event.preventDefault(); handle.focus();
      const baseline = measured(), id = handle.getAttribute(attribute);
      drag = {pointer:event.pointerId, x:event.clientX, id, width:baseline[id], baseline, handle};
      handle.setPointerCapture(event.pointerId);
      table.classList.add('is-resizing-column');
    });
    on('pointermove', event => {
      if (drag?.pointer === event.pointerId && options.canResize()) resize(drag.id, drag.width + event.clientX - drag.x, drag.baseline);
    });
    function end(event) {
      if (!drag || drag.pointer !== event.pointerId) return;
      const finished = drag; drag = null; table.classList.remove('is-resizing-column');
      if (finished.handle.hasPointerCapture(event.pointerId)) finished.handle.releasePointerCapture(event.pointerId);
      if (options.canResize()) options.persist();
    }
    for (const type of ['pointerup','pointercancel','lostpointercapture']) on(type, end);
    on('click', event => {
      if (event.target.closest(selector)) { event.preventDefault(); event.stopPropagation(); }
    });
    on('keydown', event => {
      const handle = event.target.closest(selector);
      if (!handle || !options.canResize() || !['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation();
      const baseline = measured(), id = handle.getAttribute(attribute);
      resize(id, event.key === 'Home' ? MIN : event.key === 'End' ? MAX : baseline[id] + (event.key === 'ArrowRight' ? 1 : -1) * (event.shiftKey ? 40 : 10), baseline);
      options.persist();
    });
    render();
    return {render, destroy() { drag = null; for (const remove of listeners) remove(); table.classList.remove("is-resizing-column"); }};
  }
  return {MIN, MAX, clamp, normalize, valid, attach};
});
