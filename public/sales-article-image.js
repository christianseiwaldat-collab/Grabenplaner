'use strict';
window.createSalesArticleImageUi = function ({ api, accessKey, onSaved }) {
  const el = id => document.getElementById('salesArticleImage' + id);
  const button = el('Button'), dialog = el('Dialog'), form = el('Form'), file = el('File'), url = el('Url');
  let current = {}, generation = 0, controller = null, localPreview = null, pending = false, buttonKey = '';
  const imageUrl = article => '/api/sales/articles/image?' + new URLSearchParams({ articleNumber: article.articleNumber, v: article.image?.revision || '' });
  function message(text = '', error = false) { el('Message').textContent = text; el('Message').classList.toggle('error', error); }
  function clearPreview() { if (localPreview) URL.revokeObjectURL(localPreview); localPreview = null; }
  function close() {
    generation += 1; controller?.abort(); controller = null; pending = false; clearPreview();
    dialog.close(); form.reset(); el('Preview').removeAttribute('src'); el('RemoveConfirm').classList.add('hidden'); message();
  }
  function controls() {
    const remote = el('Source').value === 'url';
    el('LocalField').classList.toggle('hidden', remote); el('UrlField').classList.toggle('hidden', !remote);
    el('Source').disabled = pending; file.disabled = pending; url.disabled = pending;
    url.required = remote; file.required = !remote;
    el('Save').disabled = pending || !current.write || (remote ? !url.value.trim() : !file.files?.length);
    el('Remove').disabled = pending; el('RemoveYes').disabled = pending;
    el('Remove').classList.toggle('hidden', !current.write || !current.image?.present);
  }
  function preview() {
    clearPreview(); const img = el('Preview');
    const selected = file.files?.[0];
    if (el('Source').value === 'local' && selected) { localPreview = URL.createObjectURL(selected); img.src = localPreview; }
    else if (current.image?.present) img.src = imageUrl(current);
    else img.removeAttribute('src');
    img.classList.toggle('hidden', !img.getAttribute('src')); controls();
  }
  async function save(remove = false) {
    if (pending || !current.write) return;
    const target = current, key = accessKey(), ownGeneration = ++generation;
    const remote = el('Source').value === 'url', selected = file.files?.[0];
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
  button.addEventListener('click', () => {
    if (!current.articleNumber || (!current.write && !current.image?.present)) return;
    form.reset(); message(); el('Title').textContent = current.write ? 'Artikelbild festlegen' : 'Artikelbild';
    el('Article').textContent = 'Artikel ' + current.articleNumber;
    el('Editor').classList.toggle('hidden', !current.write); el('Save').classList.toggle('hidden', !current.write);
    el('RemoveConfirm').classList.add('hidden'); preview(); dialog.showModal();
  });
  form.addEventListener('submit', event => { event.preventDefault(); void save(); });
  el('Source').addEventListener('change', preview); file.addEventListener('change', () => { message(); preview(); }); url.addEventListener('input', controls);
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
      const nextButtonKey = JSON.stringify([current.articleNumber, current.image?.revision, current.image?.present, current.read, current.write, key]);
      if (nextButtonKey === buttonKey) return;
      buttonKey = nextButtonKey;
      button.replaceChildren();
      const hasImage = current.read && current.image?.present;
      button.disabled = !current.articleNumber || !current.read || (!hasImage && !current.write);
      button.title = current.write ? 'Eigenes Artikelbild hinzufügen oder ändern' : hasImage ? 'Artikelbild vergrößern' : 'Kein Artikelbild vorhanden';
      button.setAttribute('aria-label', button.title);
      if (hasImage) {
        const img = document.createElement('img'); img.src = imageUrl(current); img.alt = 'Bild zu Artikel ' + current.articleNumber;
        img.addEventListener('error', () => { if (img.parentNode !== button) return; img.remove(); const text = document.createElement('span'); text.textContent = 'Bild'; button.append(text); });
        button.append(img);
      } else { const symbol = document.createElement('span'); symbol.textContent = '▧'; symbol.setAttribute('aria-hidden', 'true'); button.append(symbol); }
      if (current.write && current.articleNumber) { const edit = document.createElement('span'); edit.className = 'sales-article-image-edit'; edit.textContent = '+'; edit.setAttribute('aria-hidden', 'true'); button.append(edit); }
    },
  };
};
