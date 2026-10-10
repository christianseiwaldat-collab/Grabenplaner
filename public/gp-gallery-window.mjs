const EDGES = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'];
const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
const studioWindows = [];

function bringToFront(dialog) {
  const index = studioWindows.indexOf(dialog);
  if (index < 0) return;
  studioWindows.splice(index, 1);
  studioWindows.push(dialog);
  studioWindows.forEach((item, position) => { item.style.zIndex = String(5 + position); });
}

export function fitWindow(value, bounds, minimized = false, minimizedWidth = 320) {
  const width = Math.min(minimized ? clamp(Number(minimizedWidth) || 320, 250, 380) : Math.max(340, Number(value.width) || 680), Math.max(1, bounds.width - 16));
  const height = minimized ? Math.min(44, Math.max(1, bounds.height - 16)) : Math.min(Math.max(240, Number(value.height) || 630), Math.max(1, bounds.height - 16));
  return { width, height,
    x: clamp(Number(value.x) || 0, 8, Math.max(8, bounds.width - width - 8)),
    y: clamp(Number(value.y) || 0, 8, Math.max(8, bounds.height - height - 8)),
  };
}

export function adjustWindow(value, edge, dx, dy, bounds, minimized = false, minimizedWidth = 320) {
  const next = minimized ? fitWindow(value, bounds, true, minimizedWidth) : { ...value };
  if (minimized) {
    if (edge === 'move') { next.x += dx; next.y += dy; }
    return fitWindow(next, bounds, true, minimizedWidth);
  }
  const minWidth = Math.min(340, bounds.width - 16), minHeight = Math.min(240, bounds.height - 16);
  const right = value.x + value.width, bottom = value.y + value.height;
  if (edge === 'move') { next.x += dx; next.y += dy; }
  else if (EDGES.includes(edge)) {
    if (edge.includes('w')) { next.x = clamp(value.x + dx, 8, right - minWidth); next.width = right - next.x; }
    if (edge.includes('e')) next.width = clamp(value.width + dx, minWidth, bounds.width - value.x - 8);
    if (edge.includes('n')) { next.y = clamp(value.y + dy, 8, bottom - minHeight); next.height = bottom - next.y; }
    if (edge.includes('s')) next.height = clamp(value.height + dy, minHeight, bounds.height - value.y - 8);
  }
  return fitWindow(next, bounds);
}

export function attachStudioWindow(dialog, { key = 'gp.gallery.window.v1', width = 680, height = 630, canClose = () => true } = {}) {
  if (!studioWindows.includes(dialog)) studioWindows.push(dialog);
  studioWindows.forEach((item, position) => { item.style.zIndex = String(5 + position); });
  dialog.addEventListener('pointerdown', () => bringToFront(dialog), { capture: true });
  dialog.addEventListener('focusin', () => bringToFront(dialog));
  const title = dialog.querySelector('[data-window-title]');
  const toggle = dialog.querySelector('[data-window-toggle]');
  const windowTitle = document.getElementById(dialog.getAttribute('aria-labelledby'))?.textContent || 'Fenster';
  const minimizedWidth = clamp(windowTitle.length * 8 + 140, 250, 380);
  const bounds = () => {let height=window.innerHeight,offsetY=0;try {if(parent!==window&&window.frameElement){const frame=window.frameElement.getBoundingClientRect(),bar=window.frameElement.closest('.view')?.querySelector(':scope > .topbar'),mobile=parent.document.getElementById('mobileNavigationToggle')?.getBoundingClientRect(),top=Math.max(0,bar?.getBoundingClientRect().bottom||0,mobile?.width&&mobile.height?mobile.bottom+8:0,frame.top);offsetY=Math.max(0,top-frame.top);height=Math.min(Math.max(1,height-offsetY),Math.max(1,parent.innerHeight-top-12));}}catch{}return {width:window.innerWidth,height,offsetY};};
  let preferred, minimized = false, minimizedPosition = null, gesture = null, opener = null;
  const initial = () => ({ width, height, x: (window.innerWidth - width) / 2, y: (window.innerHeight - height) / 2 });
  try { preferred = { ...initial(), ...JSON.parse(localStorage.getItem(key) || '{}') }; } catch { preferred = initial(); }
  for (const name of ['width', 'height', 'x', 'y']) if (!Number.isFinite(preferred[name])) preferred[name] = initial()[name];
  function save() { try { localStorage.setItem(key, JSON.stringify(preferred)); } catch {} }
  function currentGeometry() { return fitWindow(minimized ? { ...preferred, ...minimizedPosition } : preferred, bounds(), minimized, minimizedWidth); }
  function applyGeometry(geometry) { if (minimized) minimizedPosition = { x: geometry.x, y: geometry.y }; else preferred = geometry; }
  function render() {
    const geometry = currentGeometry();
    Object.assign(dialog.style, { left: geometry.x + 'px', top: (geometry.y + bounds().offsetY) + 'px', width: geometry.width + 'px', height: geometry.height + 'px' });
    dialog.classList.toggle('window-minimized', minimized);
    toggle.textContent = minimized ? '▢' : '−';
    toggle.setAttribute('aria-label', windowTitle + (minimized ? ' wiederherstellen' : ' minimieren'));
    toggle.setAttribute('aria-pressed', String(minimized));
    for (const handle of dialog.querySelectorAll('[data-window-resize]')) handle.hidden = minimized;
  }
  function finish(cancel = false) {
    if (!gesture) return;
    if (cancel) { preferred = gesture.preferred; minimizedPosition = gesture.minimizedPosition; }
    const finished = gesture;
    gesture = null;
    if (finished.target.hasPointerCapture(finished.pointerId)) finished.target.releasePointerCapture(finished.pointerId);
    dialog.classList.remove('window-gesturing');
    render(); save();
  }
  function begin(event, edge) {
    if (event.button !== 0 || (edge === 'move' && event.target.closest('button, input, select, a'))) return;
    if (minimized && edge !== 'move') return;
    event.preventDefault();
    gesture = { target: event.currentTarget, pointerId: event.pointerId, edge, x: event.clientX, y: event.clientY,
      preferred: { ...preferred }, minimizedPosition: minimizedPosition ? { ...minimizedPosition } : null, geometry: currentGeometry() };
    gesture.target.setPointerCapture(event.pointerId);
    gesture.target.focus({ preventScroll: true });
    dialog.classList.add('window-gesturing');
  }
  function move(event) {
    if (!gesture || gesture.pointerId !== event.pointerId) return;
    applyGeometry(adjustWindow(gesture.geometry, gesture.edge, event.clientX - gesture.x, event.clientY - gesture.y, bounds(), minimized, minimizedWidth));
    render();
  }
  function keyboard(event, edge) {
    if (event.target !== event.currentTarget) return;
    if (event.key === 'Escape' && gesture) { event.preventDefault(); event.stopPropagation(); finish(true); return; }
    const step = event.shiftKey ? 1 : 10;
    const delta = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[event.key];
    if (delta) {
      event.preventDefault(); applyGeometry(adjustWindow(currentGeometry(), edge, ...delta, bounds(), minimized, minimizedWidth)); render(); save();
    } else if (edge === 'move' && ['Home', 'End'].includes(event.key)) {
      event.preventDefault(); const current = currentGeometry();
      applyGeometry({ ...current, x: event.key === 'Home' ? (bounds().width - current.width) / 2 : bounds().width - current.width - 8,
        y: event.key === 'Home' ? (bounds().height - current.height) / 2 : bounds().height - current.height - 8 });
      render(); save();
    }
  }
  function wire(handle, edge) {
    handle.addEventListener('pointerdown', (event) => begin(event, edge));
    handle.addEventListener('pointermove', move);
    handle.addEventListener('pointerup', () => finish());
    handle.addEventListener('pointercancel', () => finish(true));
    handle.addEventListener('lostpointercapture', () => finish());
    handle.addEventListener('keydown', (event) => keyboard(event, edge));
  }
  wire(title, 'move');
  const labels = { n: 'oben', ne: 'oben rechts', e: 'rechts', se: 'unten rechts', s: 'unten', sw: 'unten links', w: 'links', nw: 'oben links' };
  for (const edge of EDGES) {
    const handle = document.createElement('button'); handle.type = 'button';
    handle.className = 'window-resize-handle window-resize-' + edge;
    handle.dataset.windowResize = edge; handle.setAttribute('aria-label', 'Fenstergröße ändern: ' + labels[edge]);
    handle.setAttribute('aria-keyshortcuts', 'ArrowLeft ArrowRight ArrowUp ArrowDown');
    dialog.append(handle); wire(handle, edge);
  }
  toggle.addEventListener('click', () => { finish(); if (!minimized) { const current = currentGeometry(); minimizedPosition = { x: current.x, y: current.y }; } minimized = !minimized; render(); title.focus({ preventScroll: true }); });
  window.addEventListener('resize', render);
  const parentScroll=()=>{if(dialog.open)render();};
  try {if(parent!==window){parent.addEventListener('scroll',parentScroll,{capture:true,passive:true});window.addEventListener('pagehide',()=>parent.removeEventListener('scroll',parentScroll,true),{once:true});}}catch{}
  window.addEventListener('blur', () => finish());
  dialog.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    event.preventDefault(); if (gesture) finish(true); else if(canClose())dialog.close();
  });
  dialog.addEventListener('close', () => { finish(); minimized = false; opener?.focus({ preventScroll: true }); });
  return { show() { if (!dialog.open) { opener = document.activeElement; minimized = false; try { window.frameElement?.scrollIntoView({block:'start'}); } catch {} dialog.show(); } bringToFront(dialog); render(); }, restore() { minimized = false; bringToFront(dialog); render(); } };
}
