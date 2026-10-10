(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GrabenplanerTradePdfRequest=api;})(typeof window==='object'?window:globalThis,function(){
'use strict';
// api is the existing trade-workspace API, including current actor/lifecycle guards.
function aborted() {
  return Object.assign(new Error('Die PDF-Anforderung wurde verworfen.'), { name: 'AbortError' });
}

function assertCurrent(context) {
  if (context.signal?.aborted || !context.owner || context.key() !== context.owner || !context.canUse()) throw aborted();
}

function delay(ms, signal, timers = globalThis) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(aborted());
    let timer;
    const stop = () => { timers.clearTimeout(timer); reject(aborted()); };
    timer = timers.setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });
}

function capturedTarget(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new TypeError('Die PDF-Auswahl ist ungültig.');
  if (input.query && (!input.kind || typeof input.query !== 'object' || Array.isArray(input.query))) throw new TypeError('Die PDF-Auswahl ist ungültig.');
  return {
    url: typeof input.url === 'string' ? input.url : '',
    kind: typeof input.kind === 'string' ? input.kind : '',
    title: String(input.title || 'Einkauf & Bestand'),
    query: input.query ? structuredClone(input.query) : null,
    sort: String(input.sort || ''),
    direction: input.direction === 'desc' ? 'desc' : 'asc',
    jobId: '',
  };
}

async function completeTarget(payload, { api, signal, key, owner, canUse, wait = delay, status = () => {} }) {
  const context = { signal, key, owner, canUse };
  assertCurrent(context);
  if (!payload.query) return payload.url;
  if (!payload.jobId) {
    status('Ein vollständiger PDF-Ergebnisstand wird am Server erstellt. Er bleibt unter „Gespeicherte Ergebnisse“ verfügbar.');
    const created = await api('jobs', { kind: payload.kind, query: payload.query, title: payload.title }, signal);
    assertCurrent(context);
    if (!created?.id) throw Error('Der vollständige PDF-Ergebnisstand konnte nicht angelegt werden.');
    payload.jobId = String(created.id);
  }
  for (;;) {
    assertCurrent(context);
    const jobs = await api('jobs', undefined, signal);
    assertCurrent(context);
    const state = jobs.find(value => value.id === payload.jobId);
    if (!state || ['failed', 'cancelled'].includes(state.status)) throw Error('Der PDF-Ergebnisstand konnte nicht erstellt werden. Bitte gespeicherte Ergebnisse prüfen.');
    if (state.status === 'completed') {
      if (state.accessible === false) throw Error('Die Berechtigung für diesen Ergebnisstand fehlt oder wurde geändert.');
      const query = new URLSearchParams({ sort: payload.sort, direction: payload.direction });
      return '/api/trade-insights/jobs/' + encodeURIComponent(payload.jobId) + '/pdf?' + query;
    }
    if (!['queued', 'running'].includes(state.status)) throw Error('Der PDF-Ergebnisstand hat einen unbekannten Zustand.');
    await wait(1500, signal);
  }
}

function downloadUrl(url, { name, settings, validateOptions, origin }) {
  const base = new URL(origin), target = new URL(url, base);
  if (target.origin !== base.origin || target.username || target.password || target.hash || !/^\/api\/trade-insights\/jobs\/[^/]+\/pdf$/.test(target.pathname)) throw Error('Die PDF-Adresse ist ungültig.');
  if (typeof name !== 'string' || !name.trim() || name.length > 110) throw Error('Bitte einen Dateinamen mit höchstens 110 Zeichen wählen.');
  const value = validateOptions(settings);
  target.searchParams.set('name', name);
  for (const [key, part] of Object.entries(value)) target.searchParams.set(key, part);
  return target.pathname + target.search;
}

return Object.freeze({ assertCurrent, delay, capturedTarget, completeTarget, downloadUrl });

});
