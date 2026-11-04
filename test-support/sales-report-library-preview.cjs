'use strict';
// Local, synthetic preview. Uses the real library UI, table controls and mutation validator.
const fs = require('node:fs'), path = require('node:path'), express = require('express');
const { editLibrary } = require('../lib/persistence/repositories/sales-report-library');
const planningCredit = require('../lib/planning-saturday-credit');
const repo = path.resolve(__dirname, '..');
function seed() {
  const stamp = '2026-11-02T09:30:00.000Z', owner = '101';
  const folder = (id, title, parentId = '') => ({ id, title, parentId, created: stamp, updated: stamp, createdBy: owner });
  const query = { sourceId: 'compact-cash', reportVersion: 4, dateFrom: '2026-10-01', dateTo: '2026-10-31', chartType: 'bars' };
  return {
    library: { revision: 0, folders: [folder('fil18', 'Filiale 18'), folder('fil05', 'Filiale 05'), folder('year2026', '2026', 'fil18')], items: [
      { kind: 'report', id: 'october', folderId: 'fil18' }, { kind: 'report', id: 'year', folderId: 'year2026' },
      { kind: 'report', id: 'graphic', folderId: 'fil18' }, { kind: 'template', id: 'monthly', folderId: 'fil18' }, { kind: 'template', id: 'margin', folderId: 'fil18' }
    ] },
    reports: [
      { id: 'october', title: 'Oktober 2026 · Filiale 18', query, status: 'completed', format: 'pdf', created: '2026-11-01T10:15:00.000Z', updated: '2026-11-01T10:18:00.000Z', createdBy: owner, processed: 2500, durationSeconds: 180 },
      { id: 'year', title: 'Jahresvergleich 2026', query: { ...query, dateFrom: '2026-01-01' }, status: 'completed', format: 'pdf', created: '2026-11-02T07:15:00.000Z', updated: stamp, createdBy: owner, processed: 21000, durationSeconds: 620 },
      { id: 'graphic', title: 'Umsatz und Rohertrag · Oktober', query: { ...query, chartType: 'timeline', chartStyle: 'aurora' }, status: 'completed', format: 'pdf', created: '2026-11-02T08:00:00.000Z', updated: stamp, createdBy: owner, processed: 2500, durationSeconds: 100 }
    ], templates: [
      { id: 'monthly', title: '(Monat) (Jahr) · Monatsbericht', kind: 'report', query, revision: 1, created: '2026-10-10T08:30:00.000Z', updated: stamp, createdBy: owner },
      { id: 'margin', title: 'Rohertrag nach Filiale · Grafik', kind: 'graphic', query: { ...query, chartType: 'timeline' }, revision: 1, created: null, createdBy: null, updated: stamp }
    ]
  };
}
function createSalesReportLibraryPreview({ dataFile = null } = {}) {
  let data = dataFile && fs.existsSync(dataFile) ? JSON.parse(fs.readFileSync(dataFile, 'utf8')) : seed();
  data.planning ||= {};
  const app = express(); app.use(express.json({ limit: '64kb' }));
  app.use((req, res, next) => { res.set('Cache-Control', 'no-store'); const origin = req.get('origin'); if (origin && origin !== 'http://' + req.get('host')) return res.sendStatus(403); next(); });
  const persist = () => { if (dataFile) { fs.mkdirSync(path.dirname(dataFile), { recursive: true }); fs.writeFileSync(dataFile, JSON.stringify(data, null, 2)); } };
  const assets = ['styles.css', 'table-layout.css', 'sales-analytics-workspace.css', 'table-layout.js', 'sales-report-library-options.js', 'sales-report-library.js', 'planning-saturday-settings.js'];
  for (const asset of assets) app.get('/' + asset, (req, res) => res.sendFile(path.join(repo, 'public', asset)));
  app.get('/api/sales-report-library', (req, res) => res.json(data.library));
  app.patch('/api/sales-report-library', (req, res) => {
    try {
      const existing = new Set([...data.reports.map(r => 'report:' + r.id), ...data.templates.map(t => 'template:' + t.id)]);
      data.library = editLibrary(data.library, req.body, existing, { created: new Date().toISOString(), createdBy: '101' }); persist(); res.json(data.library);
    } catch (e) { res.status(e.status || 422).json({ code: e.code, error: e.code === 'IMPORT_REPORT_FOLDER_NOT_EMPTY' ? 'Der Ordner enthält noch Dateien oder Unterordner.' : e.code === 'IMPORT_REVISION_CONFLICT' ? 'Die Ablage wurde inzwischen geändert.' : 'Die Änderung ist nicht möglich.' }); }
  });
  planningCredit.registerRoutes(app, {
    authorize:()=>({employeeNumber:'101'}), scope:()=>{},
    validateLocation:async id=>{ if (!['18','05'].includes(id)) throw Object.assign(Error('Beispielstandort nicht gefunden.'),{status:404}); },
    read:id=>data.planning[id] !== false, write:async(actor,id,enabled)=>{data.planning[id]=enabled;persist();},
    error:(status,message)=>Object.assign(Error(message),{status})
  });
  app.get('/planning', (req,res)=>{
    const html=fs.readFileSync(path.join(repo,'public/index.html'),'utf8');
    const start=html.indexOf('<section class="hours-panel">'), end=html.indexOf('</section>',start)+10;
    const inline=html.slice(start,end);
    const locationStart=html.indexOf('<label class="switch-row planning-saturday-location"'), locationEnd=html.indexOf('</label>',locationStart)+8;
    const cardStart=html.indexOf('<div class="settings-card" id="planningSaturdaySettingsCard"'), cardEnd=html.indexOf('<div class="settings-card" id="crossLocationScheduleSettingsCard"',cardStart);
    res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GP · Samstagszuschlag · Lokale Vorschau</title><link rel="stylesheet" href="/styles.css"><style>body{padding:26px}.preview-shell{max-width:1200px;margin:auto}.preview-nav{display:flex;flex-wrap:wrap;gap:18px;align-items:center;margin-bottom:20px;font-size:13px}.preview-nav select{width:180px;min-height:32px;padding:5px}.preview-settings{display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:20px}.hours-grid{grid-template-columns:repeat(3,1fr)}h1{font-size:27px}.preview-settings h2{font-size:18px}.preview-settings .settings-card{padding:20px;grid-column:auto}.preview-settings .switch-row small{font-size:12px;line-height:1.5}.preview-settings .settings-note{font-size:12px;line-height:1.5}#previewError{color:#a32c26} @media(max-width:700px){body{padding:12px}.preview-settings{grid-template-columns:1fr}.hours-grid{grid-template-columns:1fr}.hours-heading{flex-wrap:wrap}}</style></head><body><main class="preview-shell"><nav class="preview-nav"><a href="/">Berichteablage</a><strong>Dienstplanung</strong><span>Lokale Vorschau · Beispieldaten</span><select id="previewLocation" aria-label="Standort"><option value="18">18 · Beispielstandort</option><option value="05">05 · Beispielstandort</option></select></nav><h1>Samstagszuschlag in der Planung</h1><p id="previewError" role="alert"></p>${inline}<div class="preview-settings"><div class="settings-card"><h2>Standortverwaltung</h2>${html.slice(locationStart,locationEnd)}</div>${html.slice(cardStart,cardEnd)}</div></main><script src="/planning-saturday-settings.js"></script><script>
      const api=async(url,options={})=>{const r=await fetch(url,{...options,headers:{'Content-Type':'application/json'}});if(!r.ok)throw Error('Vorschau konnte nicht gespeichert werden.');return r.json();};
      let locationId='18',epoch=0;
      const ui=createPlanningSaturdaySettings({api,canWrite:()=>true,capture:()=>epoch,isCurrent:t=>t===epoch,onError:e=>document.getElementById('previewError').textContent=e.message,onSaved:async()=>refresh()});
      async function refresh(){const id=locationId,ticket=epoch,s=await api('/api/portal/v1/planning-saturday-settings/'+id);if(ticket!==epoch)return;ui.render(id,s.enabled,id+' · Beispielstandort');await ui.editLocation(id);document.getElementById('hoursOverview').innerHTML=['434 · Teammitglied','435 · Teammitglied','436 · Teammitglied'].map(name=>'<article class="hours-card"><strong>'+name+'</strong><p>Aktuelle Woche · 2.–8. November 2026</p><dl><dt>Eingeteilt gesamt</dt><dd>32 Stunden</dd><dt>Gewertet</dt><dd><strong>'+(s.enabled?'34':'32')+' Stunden</strong></dd><dt>Samstagszuschlag</dt><dd>'+(s.enabled?'2':'0')+' Stunden</dd></dl></article>').join('');}
      document.getElementById('previewLocation').addEventListener('change',e=>{locationId=e.target.value;epoch++;refresh();});refresh();
    </script></body></html>`);
  });
  app.get('/preview/data', (req, res) => res.json(data));
  app.delete('/preview/items/:kind/:id', (req, res) => { const key = req.params.kind === 'template' ? 'templates' : 'reports'; data[key] = data[key].filter(x => x.id !== req.params.id); persist(); res.json({ ok: true }); });
  app.put('/preview/templates/:id', (req, res) => { const item = data.templates.find(x => x.id === req.params.id); if (!item) return res.sendStatus(404); const title = String(req.body.title || '').trim(); if (!title || title.length > 120) return res.sendStatus(422); item.title = title; item.updated = new Date().toISOString(); persist(); res.json(item); });
  app.get('/example.pdf', (req, res) => res.sendFile(path.resolve(repo, '../output/gp-sales-ui-20261102/pdf/aurora-landscape.pdf')));
  app.get('/', (req, res) => {
    const source = fs.readFileSync(path.join(repo, 'public/index.html'), 'utf8');
    const start = source.indexOf('<section class="sales-analytics-panel sales-analytics-intro-card" id="salesAnalyticsReportsPanel"');
    const end = source.indexOf('<section class="sales-analytics-panel sales-analytics-intro-card" id="salesAnalyticsGraphicsPanel"', start);
    const panel = source.slice(start, end).replace('tabindex="0" hidden', 'tabindex="0"');
    res.type('html').send(`<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>GP · Berichteablage · Lokale Vorschau</title>${assets.filter(a => a.endsWith('.css')).map(a => '<link rel="stylesheet" href="/' + a + '">').join('')}<style>.preview-note{display:block;margin-bottom:18px;color:var(--muted);font-size:12px}.main-content{min-width:0}.preview-sidebar{padding:24px 16px}.preview-sidebar h2{color:white;font-size:18px}.preview-sidebar p{color:#bdd1c9;font-size:12px}.preview-sidebar .active{margin-top:30px;padding:14px;border-radius:8px;background:#ffffff16;color:white;font-weight:700}</style></head><body><div class="app-shell"><aside class="sidebar preview-sidebar"><h2>Grabenplaner</h2><p>BEISPIEL · Filialleitung</p><div class="active">Verkaufsanalysen</div></aside><main class="main-content"><section id="salesAnalyticsView" class="view active"><header class="topbar"><div><span class="eyebrow">Verkaufsverwaltung</span><h1>Verkaufsanalysen</h1></div></header><span class="preview-note">Lokale Vorschau · Beispieldaten · <a href="/planning">Samstagszuschlag in der Dienstplanung</a></span>${panel}</section></main></div><dialog id="previewReuse" class="sales-library-dialog"><form method="dialog"><h3>Neuer Bericht aus Vorlage</h3><label>Berichtstitel<input required></label><p>Die Einstellungen des gewählten Berichts werden übernommen. In der Anwendung öffnet sich damit die Berichtserstellung.</p><button>Schließen</button></form></dialog><dialog id="previewTemplate" class="sales-library-dialog"><form method="dialog"><h3>Beispielvorlage bearbeiten</h3><label>Name<input id="previewTemplateName" maxlength="120" required></label><p>Die Vorschau ändert nur die synthetische Vorlage.</p><button value="cancel" formnovalidate>Abbrechen</button><button value="save">Speichern</button></form></dialog>${assets.filter(a => a.endsWith('.js')).map(a => '<script src="/' + a + '"></script>').join('')}<script>
    const api=async(url,options={})=>{const response=await fetch(url,{...options,headers:{'Content-Type':'application/json'}});const value=await response.json();if(!response.ok)throw Object.assign(Error(value.error||'Vorschau konnte nicht aktualisiert werden.'),{code:value.code});return value;};
    let demoData, demoLibrary;
    const refresh=async()=>{demoData=await api('/preview/data');demoLibrary.update(demoData.reports,demoData.templates,demoData.library);};
    const error=e=>{const box=document.getElementById('salesReportJobError');box.hidden=false;box.textContent=e.message;};
    demoLibrary=createSalesReportLibraryUi({api,onError:error,reportSummary:r=>r.processed+' Beispielpositionen',
      reportActions:r=>[{label:'PDF öffnen',primary:true,run:()=>window.open('/example.pdf','_blank','noopener')},{label:'PDF herunterladen',run:()=>{const a=document.createElement('a');a.href='/example.pdf';a.download='Beispielbericht.pdf';a.click();}},{label:'Als Vorlage für neuen Bericht verwenden',run:()=>{const d=document.getElementById('previewReuse');d.querySelector('input').value=demoLibrary.title(r,'report');d.showModal();}},{label:'Entfernen',run:async()=>{await api('/preview/items/report/'+r.id,{method:'DELETE'});await refresh();}}],
      editTemplate:async id=>{const item=demoData.templates.find(t=>t.id===id),dialog=document.getElementById('previewTemplate');document.getElementById('previewTemplateName').value=item.title;dialog.returnValue='';dialog.addEventListener('close',async()=>{if(dialog.returnValue==='save'){await api('/preview/templates/'+id,{method:'PUT',body:JSON.stringify({title:document.getElementById('previewTemplateName').value})});await refresh();}},{once:true});dialog.showModal();},
      deleteTemplate:async item=>{await api('/preview/items/template/'+item.id,{method:'DELETE'});await refresh();}});
    document.getElementById('salesReportJobRefresh').addEventListener('click',()=>refresh().catch(error));
    refresh().then(()=>document.querySelector('#salesLibraryFolders [data-drop-folder="fil18"]').click()).catch(error);
    </script></body></html>`);
  });
  return { app, snapshot: () => structuredClone(data) };
}
if (require.main === module) {
  const file = path.resolve(repo, '../output/gp-sales-ui-20261102/live-preview/state.json');
  const preview = createSalesReportLibraryPreview({ dataFile: file });
  const server = preview.app.listen(0, '127.0.0.1', () => {
    const url = 'http://127.0.0.1:' + server.address().port;
    const receipt = { url, pid: process.pid, syntheticOnly: true, created: new Date().toISOString() };
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(path.join(path.dirname(file), 'server.json'), JSON.stringify(receipt, null, 2)); console.log(url);
  });
}
module.exports = { createSalesReportLibraryPreview };
