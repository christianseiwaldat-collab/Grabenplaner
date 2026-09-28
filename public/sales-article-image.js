'use strict';
window.createSalesArticleImageUi = function ({ api, accessKey, onSaved }) {
  const el = id => document.getElementById('salesArticleImage' + id);
  const button = el('Button'), dialog = el('Dialog'), form = el('Form'), file = el('File'), url = el('Url');
  const search = el('Search'), edit = el('Edit'), searchStatus = el('SearchStatus');
  let current = {}, generation = 0, controller = null, localPreview = null, pending = false, buttonKey = '', pastedFile = null, editing = false;
  const imageUrl = article => '/api/sales/articles/image?' + new URLSearchParams({ articleNumber: article.articleNumber, v: article.image?.revision || '' });
  function message(text = '', error = false) { el('Message').textContent = text; el('Message').classList.toggle('error', error); }
  function clearPreview() { if (localPreview) URL.revokeObjectURL(localPreview); localPreview = null; }
  function close() {
    generation += 1; controller?.abort(); controller = null; pending = false; clearPreview();
    dialog.close(); form.reset(); pastedFile = null; el('Preview').removeAttribute('src'); el('RemoveConfirm').classList.add('hidden'); message();
  }
  function controls() {
    const remote = el('Source').value === 'url';
    el('LocalField').classList.toggle('hidden', remote); el('UrlField').classList.toggle('hidden', !remote);
    el('Source').disabled = pending; file.disabled = pending; url.disabled = pending;
    url.required = editing && remote; file.required = editing && !remote && !pastedFile;
    el('Save').classList.toggle('hidden', !editing);
    el('Save').disabled = pending || !editing || !current.write || (remote ? !url.value.trim() : !pastedFile && !file.files?.length);
    el('Remove').disabled = pending; el('RemoveYes').disabled = pending;
    el('Remove').classList.toggle('hidden', !editing || !current.write || !current.image?.present);
  }
  function preview() {
    clearPreview(); const img = el('Preview');
    const selected = pastedFile || file.files?.[0];
    if (el('Source').value === 'local' && selected) { localPreview = URL.createObjectURL(selected); img.src = localPreview; }
    else if (current.image?.present) img.src = imageUrl(current);
    else img.removeAttribute('src');
    img.classList.toggle('hidden', !img.getAttribute('src')); controls();
  }
  async function save(remove = false) {
    if (pending || !editing || !current.write) return;
    const target = current, key = accessKey(), ownGeneration = ++generation;
    const remote = el('Source').value === 'url', selected = pastedFile || file.files?.[0];
    if (!remove && !remote && (!selected || selected.size > 10 * 1024 * 1024)) { message('Bitte ein Bild mit höchstens 10 MB auswählen.', true); return; }
    pending = true; controller = new AbortController(); controls(); message(remove ? 'Bild wird entfernt …' : 'Bild wird übernommen …');
    try {
      const expectedRevision = target.image?.revision || null;
      const endpoint = '/api/sales/articles/image';
      const result = remove ? await api(endpoint, { method: 'DELETE', signal: controller.signal, body: JSON.stringify({ articleNumber: target.articleNumber, expectedRevision }) })
        : remote ? await api(endpoint + '/from-url', { method: 'POST', signal: controller.signal, body: JSON.stringify({ articleNumber: target.articleNumber, expectedRevision, url: url.value.trim() }) })
          : await api(endpoint + '?' + new URLSearchParams({ articleNumber: target.articleNumber }), { method: 'PUT', signal: controller.signal,
            headers: { 'Content-Type': 'application/octet-stream', 'X-Article-Image-Revision': expectedRevision || 'none' }, body: selected });
      if (generation !== ownGeneration || key !== accessKey() || current.articleNumber !== target.articleNumber) return;
      close(); onSaved(result.articleNumber, result.image);
    } catch (error) {
      if (generation !== ownGeneration || key !== accessKey()) return;
      message(error.code === 'ARTICLE_IMAGE_CONFLICT' ? 'Das Bild wurde inzwischen geändert. Bitte schließen und den Artikel neu öffnen.' : error.message, true);
    } finally { if (generation === ownGeneration) { pending = false; controller = null; controls(); } }
  }
  function open(mode) {
    if (!current.articleNumber || (!current.write && !current.image?.present)) return;
    editing = mode === 'edit' && current.write;
    form.reset(); pastedFile = null; message(); el('Title').textContent = editing ? 'Artikelbild festlegen' : 'Artikelbild';
    el('Article').textContent = 'Artikel ' + current.articleNumber;
    el('Editor').classList.toggle('hidden', !editing);
    dialog.classList.toggle('viewer', !editing);
    const size = Math.max(240, Math.ceil(button.getBoundingClientRect().width * 2));
    dialog.style.setProperty('--article-image-zoom-size', size + 'px');
    el('RemoveConfirm').classList.add('hidden'); preview(); dialog.showModal();
  }
  button.addEventListener('click', () => open(current.image?.present ? 'view' : 'edit'));
  edit.addEventListener('click', () => open('edit'));
  search.addEventListener('click', event => {
    if (!search.hasAttribute('href')) { event.preventDefault(); return; }
    searchStatus.textContent = current.write ? 'Google-Suche geöffnet · Bild kopieren und im Bilddialog einfügen.' : 'Google-Bildersuche geöffnet.';
    if (current.write) open('edit');
  });
  function acceptFile(value) {
    if (pending || !editing || !current.write) return;
    if (!value || !['image/jpeg','image/png','image/webp'].includes(value.type) || value.size > 10 * 1024 * 1024) {
      message('Bitte ein JPG-, PNG- oder WebP-Bild mit höchstens 10 MB verwenden.', true); return;
    }
    pastedFile = value; file.value = ''; el('Source').value = 'local'; preview(); message('Bild eingefügt. Mit „Bild übernehmen“ dauerhaft speichern.');
  }
  dialog.addEventListener('paste', event => {
    if (!editing || pending) return;
    const item = [...(event.clipboardData?.items || [])].find(i => i.kind === 'file' && i.type.startsWith('image/'));
    if (item) { event.preventDefault(); acceptFile(item.getAsFile()); }
  });
  el('Paste').addEventListener('dragover', event => { if (editing && !pending) event.preventDefault(); });
  el('Paste').addEventListener('drop', event => { event.preventDefault(); acceptFile(event.dataTransfer?.files?.[0]); });
  form.addEventListener('submit', event => { event.preventDefault(); void save(); });
  el('Source').addEventListener('change', preview); file.addEventListener('change', () => { pastedFile = null; message(); preview(); }); url.addEventListener('input', controls);
  el('Preview').addEventListener('error', () => { el('Preview').classList.add('hidden'); message('Die Bildvorschau ist nicht verfügbar. Bitte eine lesbare Bilddatei verwenden.', true); });
  el('Remove').addEventListener('click', () => { el('RemoveConfirm').classList.remove('hidden'); el('RemoveYes').focus(); });
  el('RemoveYes').addEventListener('click', () => void save(true));
  el('RemoveNo').addEventListener('click', () => el('RemoveConfirm').classList.add('hidden'));
  dialog.querySelectorAll('[data-close-article-image]').forEach(b => b.addEventListener('click', close));
  dialog.addEventListener('cancel', event => { event.preventDefault(); close(); });
  return {
    reset: close,
    render(value) {
      const key = accessKey();
      if (current.articleNumber !== value.articleNumber || current.access !== key) close();
      current = { ...value, access: key };
      const nextButtonKey = JSON.stringify([current.articleNumber, current.ean, current.image?.revision, current.image?.present, current.read, current.write, key]);
      if (nextButtonKey === buttonKey) return;
      buttonKey = nextButtonKey;
      const searchable = current.read && /^(?:\d{8}|\d{12,14})$/.test(current.ean || '');
      if (searchable) search.href = 'https://www.google.com/search?tbm=isch&q=' + encodeURIComponent(current.ean);
      else search.removeAttribute('href');
      search.setAttribute('aria-disabled', String(!searchable));
      searchStatus.textContent = searchable ? '' : 'Keine EAN für die Bildersuche hinterlegt.';
      edit.classList.toggle('hidden', !current.write || !current.image?.present);
      button.replaceChildren();
      const hasImage = current.read && current.image?.present;
      button.disabled = !current.articleNumber || !current.read || (!hasImage && !current.write);
      button.title = hasImage ? 'Artikelbild vergrößern' : current.write ? 'Eigenes Artikelbild hinzufügen' : 'Kein Artikelbild vorhanden';
      button.setAttribute('aria-label', button.title);
      if (hasImage) {
        const img = document.createElement('img'); img.src = imageUrl(current); img.alt = 'Bild zu Artikel ' + current.articleNumber;
        img.addEventListener('error', () => { if (img.parentNode !== button) return; img.remove(); const text = document.createElement('span'); text.textContent = 'Bild'; button.append(text); });
        button.append(img);
      } else { const symbol = document.createElement('span'); symbol.textContent = '▧'; symbol.setAttribute('aria-hidden', 'true'); button.append(symbol); }
      if (current.write && current.articleNumber && !hasImage) { const symbol = document.createElement('span'); symbol.className = 'sales-article-image-edit'; symbol.textContent = '+'; symbol.setAttribute('aria-hidden', 'true'); button.append(symbol); }
    },
  };
};
