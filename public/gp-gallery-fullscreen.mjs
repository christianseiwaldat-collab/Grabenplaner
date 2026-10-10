// Geometry uses CSS pixels: at scale 1 each natural image pixel is one CSS pixel.
export function clampImagePosition(view) {
  const scaledWidth = view.imageWidth * view.scale, scaledHeight = view.imageHeight * view.scale;
  return {
    ...view,
    x: scaledWidth <= view.width ? (view.width - scaledWidth) / 2 : Math.max(view.width - scaledWidth, Math.min(0, view.x)),
    y: scaledHeight <= view.height ? (view.height - scaledHeight) / 2 : Math.max(view.height - scaledHeight, Math.min(0, view.y)),
  };
}

export function fitImage({ width, height, imageWidth, imageHeight }) {
  const scale = width > 0 && height > 0 && imageWidth > 0 && imageHeight > 0
    ? Math.min(1, width / imageWidth, height / imageHeight) : 1;
  return clampImagePosition({ width, height, imageWidth, imageHeight, scale, x: 0, y: 0 });
}

export function zoomImageAt(view, scale, anchor = { x: view.width / 2, y: view.height / 2 }) {
  if (!Number.isFinite(scale) || scale <= 0 || !Number.isFinite(view.scale) || view.scale <= 0) return { ...view };
  const ratio = scale / view.scale;
  return clampImagePosition({
    ...view, scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  });
}

export function resizeImageView(view, width, height, fit = false) {
  if (fit) return fitImage({ ...view, width, height });
  // Preserve the pixel at the old viewport centre when the available area changes.
  return clampImagePosition({
    ...view, width, height,
    x: view.x + (width - view.width) / 2,
    y: view.y + (height - view.height) / 2,
  });
}

export function attachImageFullscreen({ dialog, stage, image, title, position, previous, next, fitButton, actualButton, zoomOut, zoomIn, zoomLabel, closeButton, onNavigate, onClose }) {
  const doc = dialog.ownerDocument, win = doc.defaultView;
  // A dialog itself is excluded from the Fullscreen API; its child surface is not.
  const surface = dialog.querySelector('.fullscreen-surface') ?? dialog;
  let opened = false, nativeFullscreen = false, source = '', mode = 'fit', view = null, pan = null, suppressClickUntil = 0, scrollLockedHere = false, session = 0;
  let data = { src: '', alt: '', title: '', position: '', canNavigate: false };

  image.draggable = false;
  image.style.position = 'absolute';
  image.style.left = image.style.top = '0';
  image.style.maxWidth = image.style.maxHeight = 'none';
  image.style.transformOrigin = '0 0';

  function metrics() {
    const rect = stage.getBoundingClientRect();
    return { width: stage.clientWidth || rect.width, height: stage.clientHeight || rect.height, left: rect.left + (stage.clientLeft || 0), top: rect.top + (stage.clientTop || 0) };
  }
  function navigationAllowed(direction) {
    return typeof data.canNavigate === 'object' && data.canNavigate !== null
      ? !!data.canNavigate[direction < 0 ? 'previous' : 'next'] : !!data.canNavigate;
  }
  function minScale() { return view ? Math.min(0.05, fitImage(view).scale) : 0.05; }
  function canPan() { return !!view && (view.imageWidth * view.scale > view.width + 0.5 || view.imageHeight * view.scale > view.height + 0.5); }
  function paint() {
    title.textContent = data.title;
    position.textContent = data.position;
    previous.disabled = !navigationAllowed(-1);
    next.disabled = !navigationAllowed(1);
    fitButton.disabled = actualButton.disabled = !view;
    zoomOut.disabled = !view || view.scale <= minScale() + 0.000001;
    zoomIn.disabled = !view || view.scale >= 8 - 0.000001;
    fitButton.setAttribute('aria-pressed', String(mode === 'fit'));
    actualButton.setAttribute('aria-pressed', String(mode === 'actual'));
    dialog.dataset.imageMode = mode;
    stage.classList.toggle('can-pan', canPan());
    zoomLabel.textContent = view ? Math.round(view.scale * 100) + ' %' : 'Lädt…';
    if (!view) { image.style.visibility = 'hidden'; return; }
    image.style.width = view.imageWidth + 'px';
    image.style.height = view.imageHeight + 'px';
    image.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`;
    image.style.visibility = 'visible';
  }
  function endPan(event) {
    if (!pan || (event?.pointerId !== undefined && event.pointerId !== pan.pointerId)) return;
    const active = pan;
    pan = null;
    stage.classList.remove('is-panning');
    if (active.moved) suppressClickUntil = Date.now() + 300;
    try { if (stage.hasPointerCapture?.(active.pointerId)) stage.releasePointerCapture(active.pointerId); } catch { /* Capture may already have ended. */ }
  }
  function refreshGeometry() {
    if (!opened || !image.complete || !image.naturalWidth || !image.naturalHeight) return;
    const { width, height } = metrics();
    if (width <= 0 || height <= 0) return;
    endPan();
    const dimensions = { width, height, imageWidth: image.naturalWidth, imageHeight: image.naturalHeight };
    const changedDimensions = view && (view.imageWidth !== dimensions.imageWidth || view.imageHeight !== dimensions.imageHeight);
    if (!view || mode === 'fit' || changedDimensions) {
      if (changedDimensions) mode = 'fit';
      view = fitImage(dimensions);
    } else view = resizeImageView(view, width, height);
    paint();
  }
  function setMode(nextMode) {
    if (!view) return;
    endPan();
    mode = nextMode;
    view = mode === 'fit' ? fitImage(view) : clampImagePosition({ ...view, scale: 1, x: (view.width - view.imageWidth) / 2, y: (view.height - view.imageHeight) / 2 });
    paint();
  }
  function toggleMode() { setMode(mode === 'fit' ? 'actual' : 'fit'); }
  function zoomBy(factor, anchor) {
    if (!view || !Number.isFinite(factor) || factor <= 0) return;
    endPan();
    const scale = Math.max(minScale(), Math.min(8, view.scale * factor));
    view = zoomImageAt(view, scale, anchor);
    mode = Math.abs(scale - 1) < 0.000001 ? 'actual' : 'zoom';
    paint();
  }
  function navigate(direction) { if (opened && navigationAllowed(direction)) onNavigate?.(direction); }
  function exitNativeFullscreen() {
    if (doc.fullscreenElement !== surface) return;
    try { Promise.resolve(doc.exitFullscreen?.()).catch(() => {}); } catch { /* A viewport-sized dialog also works without native fullscreen. */ }
  }
  function close() {
    if (!opened) return;
    opened = false;
    nativeFullscreen = false;
    dialog.dataset.fullscreenMode = 'window';
    endPan();
    if (scrollLockedHere) { doc.documentElement.classList.remove('image-fullscreen-open'); scrollLockedHere = false; }
    if (dialog.open) dialog.close();
    exitNativeFullscreen();
    onClose?.();
  }
  function update(nextData = {}) {
    data = { ...data, ...nextData };
    image.alt = data.alt;
    const nextSource = String(data.src ?? '');
    if (nextSource !== source) {
      endPan();
      source = nextSource;
      mode = 'fit';
      view = null;
      image.style.visibility = 'hidden';
      image.src = source;
      if (image.complete) refreshGeometry();
    } else if (!view && image.complete) refreshGeometry();
    paint();
  }
  function show(nextData) {
    if (opened) { update(nextData); return; }
    if (!dialog.open) dialog.showModal();
    opened = true;
    const requestSession = ++session;
    nativeFullscreen = false;
    dialog.dataset.fullscreenMode = 'window';
    delete dialog.dataset.fullscreenError;
    delete dialog.dataset.fullscreenErrorMessage;
    if (!doc.documentElement.classList.contains('image-fullscreen-open')) {
      doc.documentElement.classList.add('image-fullscreen-open');
      scrollLockedHere = true;
    }
    mode = 'fit';
    view = null;
    suppressClickUntil = 0;
    update(nextData);
    stage.focus({ preventScroll: true });
    // Keep the user activation from show(): request immediately, without awaiting anything.
    try {
      if (surface.requestFullscreen) Promise.resolve(surface.requestFullscreen()).then(() => {
        if (!opened) exitNativeFullscreen();
        else if (doc.fullscreenElement === surface) { nativeFullscreen = true; dialog.dataset.fullscreenMode = 'browser'; refreshGeometry(); }
      }).catch((error) => {
        if (opened && session === requestSession) { dialog.dataset.fullscreenError = String(error?.name || 'Error'); dialog.dataset.fullscreenErrorMessage = String(error?.message || ''); }
      });
    } catch (error) { if (opened && session === requestSession) { dialog.dataset.fullscreenError = String(error?.name || 'Error'); dialog.dataset.fullscreenErrorMessage = String(error?.message || ''); } }
  }

  closeButton.addEventListener('click', close);
  // Native close events are queued; an event from an earlier session must not
  // dismiss a dialog which has already been opened again.
  dialog.addEventListener('close', () => { if (!dialog.open) close(); });
  dialog.addEventListener('cancel', (event) => { event.preventDefault(); event.stopPropagation(); close(); });
  dialog.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); return; }
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); event.stopPropagation(); navigate(event.key === 'ArrowLeft' ? -1 : 1);
    } else if (event.target === stage && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault(); event.stopPropagation(); toggleMode();
    }
  });
  previous.addEventListener('click', () => navigate(-1));
  next.addEventListener('click', () => navigate(1));
  fitButton.addEventListener('click', () => setMode('fit'));
  actualButton.addEventListener('click', () => setMode('actual'));
  zoomOut.addEventListener('click', () => zoomBy(1 / 1.25));
  zoomIn.addEventListener('click', () => zoomBy(1.25));
  image.addEventListener('load', refreshGeometry);
  image.addEventListener('error', () => { view = null; paint(); zoomLabel.textContent = 'Bild nicht verfügbar'; });
  image.addEventListener('dragstart', (event) => event.preventDefault());
  stage.addEventListener('click', (event) => {
    // Pointer capture can retarget a stationary image click to the viewport.
    if (event.target !== stage && event.target !== image) return;
    event.preventDefault(); event.stopPropagation();
    if (Date.now() >= suppressClickUntil) toggleMode();
  });
  stage.addEventListener('wheel', (event) => {
    if (!opened || !view) return;
    event.preventDefault();
    const { left, top } = metrics();
    const pixels = event.deltaY * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? view.height : 1);
    zoomBy(Math.exp(-Math.max(-1000, Math.min(1000, pixels)) * 0.002), { x: event.clientX - left, y: event.clientY - top });
  }, { passive: false });
  stage.addEventListener('pointerdown', (event) => {
    if (!opened || !canPan() || event.button !== 0 || (event.target !== stage && event.target !== image)) return;
    pan = { pointerId: event.pointerId, clientX: event.clientX, clientY: event.clientY, x: view.x, y: view.y, moved: false };
    try { stage.setPointerCapture?.(event.pointerId); } catch { /* Dragging still works inside the stage. */ }
  });
  stage.addEventListener('pointermove', (event) => {
    if (!pan || event.pointerId !== pan.pointerId) return;
    const dx = event.clientX - pan.clientX, dy = event.clientY - pan.clientY;
    if (!pan.moved && Math.hypot(dx, dy) < 4) return;
    pan.moved = true;
    event.preventDefault();
    stage.classList.add('is-panning');
    view = clampImagePosition({ ...view, x: pan.x + dx, y: pan.y + dy });
    paint();
  });
  for (const name of ['pointerup', 'pointercancel', 'lostpointercapture']) stage.addEventListener(name, endPan);
  doc.addEventListener('fullscreenchange', () => {
    if (!opened) return;
    if (doc.fullscreenElement === surface) { nativeFullscreen = true; dialog.dataset.fullscreenMode = 'browser'; refreshGeometry(); }
    else if (nativeFullscreen) close();
  });
  win?.addEventListener('resize', refreshGeometry);
  if (win?.ResizeObserver) new win.ResizeObserver(refreshGeometry).observe(stage);

  return { show, update, close, isOpen: () => opened && dialog.open };
}
