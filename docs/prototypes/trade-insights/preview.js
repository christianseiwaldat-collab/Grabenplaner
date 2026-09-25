'use strict';
// Synthetic design examples, deliberately independent of all product APIs.
const $=s=>document.querySelector(s),esc=v=>String(v??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const articles=[
 {id:'D-1001',name:'Systemkamera A · Gehäuse',group:'Kameras',status:'Aktiv',date:'18.09.2026',origin:'Trade_Daten',state:'good'},
 {id:'D-1002',name:'Objektiv 50 mm · Serie Classic',group:'Objektive',status:'Archiviert',date:'02.06.2026',origin:'WEUM · Artikelarchiv',state:'info'},
 {id:'D-1003',name:'Reisestativ Compact',group:'Zubehör',status:'Aktiv',date:'18.09.2026',origin:'Trade_Daten',state:'good'},
 {id:'D-1004',name:'Kameratasche M · Serie Classic',group:'Zubehör',status:'Archiviert',date:'14.03.2026',origin:'WEUM · Artikelarchiv',state:'info'},
 {id:'D-1005',name:'Akku Typ B',group:'Zubehör',status:'Zuordnung prüfen',date:'18.09.2026',origin:'Mehrere Artikelreferenzen',state:'warn'}
];
const movements=[
 {id:'WE-1042',date:'2026-09-18',article:'D-1001',kind:'Wareneingang',qty:4,from:'Fotohandel Demo',to:'Zentrallager',order:'B-26104',doc:'LS-4801',quality:'Beleg zugeordnet'},
 {id:'UM-1041',date:'2026-09-17',article:'D-1001',kind:'Umlagerung',qty:2,from:'Zentrallager',to:'Filiale A',order:'—',doc:'Korb K-120',quality:'Umlagerung gebucht'},
 {id:'WE-1040',date:'2026-09-17',article:'D-1003',kind:'Wareneingang',qty:8,from:'Zubehörhandel Demo',to:'Filiale B',order:'B-26102',doc:'LS-4789',quality:'Beleg zugeordnet'},
 {id:'WE-1039',date:'2026-09-16',article:'D-1002',kind:'Wareneingang',qty:-1,from:'Fotohandel Demo',to:'Filiale A',order:'—',doc:'LS-4782',quality:'Negative Menge prüfen'},
 {id:'UM-1038',date:'2026-09-15',article:'D-1004',kind:'Umlagerung',qty:null,from:'Filiale B',to:'Filiale A',order:'—',doc:'Korb K-118',quality:'Menge fehlt'}
];
const counts=[
 {id:'I-2609-A',date:'2026-09-15',branch:'Filiale A',total:128,plus:1,minus:1,check:1},
 {id:'I-2609-B',date:'2026-09-14',branch:'Filiale B',total:96,plus:1,minus:1,check:0},
 {id:'I-2608-A',date:'2026-08-20',branch:'Filiale A',total:114,plus:0,minus:1,check:0}
];
const countDetails={
 'I-2609-A':[['D-1001',3,2,-1],['D-1003',6,7,1],['D-1004',null,2,null]],
 'I-2609-B':[['D-1003',10,9,-1],['D-1004',1,2,1]],
 'I-2608-A':[['D-1001',4,3,-1]]
};
const suggestions=[
 {id:'S-1',article:'D-1001',branch:'Filiale A',type:'Umlagerung prüfen',reason:'Nachfrage in Filiale A, Bestand in Filiale B.',state:'info'},
 {id:'S-2',article:'D-1003',branch:'Filiale B',type:'Abverkauf prüfen',reason:'Bestand vorhanden, im betrachteten Zeitraum kein Verkauf.',state:'info'},
 {id:'S-3',article:'D-1005',branch:'Filiale A',type:'Datengrundlage prüfen',reason:'Artikelreferenz uneindeutig; kein Mengenvorschlag möglich.',state:'warn'}
];
const config={
 articles:{title:'Artikelhistorie',description:'Aktuelle und archivierte Artikel gemeinsam finden. Herkunft und Status bleiben nachvollziehbar.',source:'Artikelstamm und Archiv: 18.09.2026',search:'Artikelnummer oder Bezeichnung',filterLabel:'Artikelstatus',options:['Aktiv','Archiviert','Zuordnung prüfen'],branch:false,note:'Archivierte Referenzen erklären historische Belege. Sie werden dadurch nicht wieder zu aktiven Verkaufsartikeln.'},
 movements:{title:'Warenbewegungen',description:'Wareneingänge und Umlagerungen mit Artikel, Menge, Filiale und Belegverweisen.',source:'Warenbewegungen: 18.09.2026 · Bestellungen: 17.09.2026',search:'Artikel, Beleg oder Lieferant',filterLabel:'Bewegungsart',options:['Wareneingang','Umlagerung'],branch:true,note:'Mengenzeichen bleiben erhalten. Eine gebuchte Umlagerung enthält keine gesonderte Empfangsbestätigung. Fehlende Bestellbezüge sind kein Nachweis einer offenen Bestellung.'},
 counts:{title:'Inventuren & Differenzen',description:'Inventuren je Filiale überblicken und auffällige Positionen gezielt nachschlagen.',source:'Inventurprotokoll: 15.09.2026',search:'Inventurnummer oder Filiale',filterLabel:'Inventuren',options:['Mit Mengendifferenz','Mit Prüffall'],branch:true,note:'Die Übersicht enthält Summen aller Positionen. Einzelheiten stehen für Differenzen und unvollständige Mengen zur Verfügung; unveränderte Zählstände bleiben im lokalen Archiv.'},
 suggestions:{title:'Handlungsvorschläge',description:'Hinweise für Filialversorgung und Abverkauf – mit sichtbarer Begründung und Datengrundlage.',source:'Bestand: 18.09.2026 · Verkäufe: 21.06.–18.09.2026 · Bewegungen: 18.09.2026',search:'Artikel oder Hinweis',filterLabel:'Hinweisart',options:['Umlagerung prüfen','Abverkauf prüfen','Datengrundlage prüfen'],branch:true,note:'Die Hinweise bereiten Entscheidungen vor. Reservierungen, offene Beschaffung und Mindestbestände müssen vor einer Mengenentscheidung geprüft sein.'}
};
let view='movements',filters={query:'',branch:'',kind:''},sortDesc=true;
const badge=(v,t='')=>`<span class="gp-badge ${t}">${esc(v)}</span>`;
const date=v=>v.split('-').reverse().join('.');
const article=id=>articles.find(a=>a.id===id);
const articleCell=id=>`<button class="gp-link" data-article="${esc(id)}">${esc(article(id)?.name||id)}</button><small>${esc(id)}${article(id)?.status==='Archiviert'?' · archiviert':''}</small>`;
const stat=(label,value,note)=>`<div class="gp-stat"><span>${esc(label)}</span><strong>${esc(value)}</strong><small>${esc(note)}</small></div>`;
const facts=rows=>`<dl class="gp-detail-grid">${rows.map(([k,v])=>`<div><dt>${esc(k)}</dt><dd>${esc(v)}</dd></div>`).join('')}</dl>`;
function table(headers,rows){return `<div class="gp-table-wrap"><table><thead><tr>${headers.map(h=>`<th scope="col"${h==='Datum'?` aria-sort="${sortDesc?'descending':'ascending'}"`:''}>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.map(row=>`<tr>${row.map((v,i)=>`<td data-label="${esc(headers[i])}"${['Menge','Positionen','Fehlmenge','Mehrmenge','Prüffälle','Differenz','Vorher','Gezählt'].includes(headers[i])?' class="gp-number"':''}>${v}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;}
function render(){
 const c=config[view];
 document.querySelectorAll('[data-view]').forEach(b=>{b.setAttribute('aria-selected',String(b.dataset.view===view));b.tabIndex=b.dataset.view===view?0:-1;});
 $('#content').setAttribute('aria-labelledby','tab-'+view);
 $('#content').innerHTML=`<div class="gp-section-head"><div><h2>${c.title}</h2><p class="gp-explainer">${c.description}</p></div></div><div class="gp-source"><strong>Datenstand</strong> · ${c.source}<br>Beispielimport: 25.09.2026, 10:15 Uhr</div>${$('#scenario').value==='stale'?'<div class="gp-notice"><strong>Beispiel: Daten für aktuelle Entscheidungen zu alt.</strong> Historische Recherche bleibt möglich. Handlungsvorschläge sind bis zu einem passenden neuen Datenstand ausgesetzt.</div>':''}<form class="gp-filters" id="filters"><label>Suche<input name="query" placeholder="${c.search}" value="${esc(filters.query)}" type="search"></label><label>${c.branch?'Filiale':'Sortiment'}<select name="branch"><option value="">Alle ${c.branch?'Filialen':'Sortimente'}</option>${(c.branch?['Filiale A','Filiale B','Zentrallager']:['Kameras','Objektive','Zubehör']).map(v=>`<option${filters.branch===v?' selected':''}>${esc(v)}</option>`).join('')}</select></label><label>${c.filterLabel}<select name="kind"><option value="">Alle</option>${c.options.map(v=>`<option${filters.kind===v?' selected':''}>${esc(v)}</option>`).join('')}</select></label><button class="gp-primary" type="submit">Anzeigen</button></form><div id="results" aria-live="polite"></div><p class="gp-note">${c.note}</p>`;
 if($('#scenario').value==='empty')$('.gp-source').innerHTML='<strong>Datenstand</strong> · Noch kein Import vorhanden';
 $('#filters').onsubmit=e=>{e.preventDefault();filters=Object.fromEntries(new FormData(e.currentTarget));renderResults();};
 renderResults();
}
function renderResults(){
 const target=$('#results'),scenario=$('#scenario').value;
 if(scenario==='empty'){target.innerHTML='<div class="gp-empty"><h3>Noch keine Daten übernommen</h3><p>Nach dem passenden Datenbankimport stehen hier die Auswertungen zur Verfügung.</p><button data-source-help>Benötigte Datenbanken anzeigen</button></div>';return;}
 if(scenario==='stale'&&view==='suggestions'){target.innerHTML='<div class="gp-empty"><h3>Aktuelle Hinweise pausiert</h3><p>Die Beispielquellen passen zeitlich nicht ausreichend zusammen. Nach einer Aktualisierung können neue Hinweise berechnet werden.</p><button data-source-help>Datenanforderungen anzeigen</button></div>';return;}
 let rows=({articles,movements,counts,suggestions})[view].filter(r=>{
  const text=JSON.stringify(r)+' '+(article(r.article)?.name||'');
  const query=filters.query.toLocaleLowerCase('de');
  const branch=filters.branch;
  const kind=filters.kind;
  return text.toLocaleLowerCase('de').includes(query)&&(!branch||[r.branch,r.from,r.to,r.group].includes(branch))&&(!kind||kind===r.status||kind===r.kind||kind===r.type||kind==='Mit Prüffall'&&r.check>0||kind==='Mit Mengendifferenz'&&(r.plus+r.minus)>0);
 });
 if(['movements','counts'].includes(view))rows.sort((a,b)=>sortDesc?b.date.localeCompare(a.date):a.date.localeCompare(b.date));
 if(!rows.length){target.innerHTML='<div class="gp-empty"><h3>Keine passenden Ergebnisse</h3><p>Versuche einen anderen Suchbegriff oder erweitere die Filter.</p><button data-reset>Filter zurücksetzen</button></div>';return;}
 let stats,headers,cells;
 if(view==='articles'){
  stats=stat('Artikelreferenzen',rows.length,'in dieser Auswahl')+stat('Archiviert',rows.filter(r=>r.status==='Archiviert').length,'historisch gekennzeichnet')+stat('Zuordnung prüfen',rows.filter(r=>r.state==='warn').length,'keine automatische Verbindung');
  headers=['Artikel','Sortiment','Status','Referenzquelle','Stand / Archivdatum','Aktion'];
  cells=rows.map(r=>[articleCell(r.id),esc(r.group),badge(r.status,r.state),esc(r.origin),esc(r.date),`<button data-article="${r.id}">Details</button>`]);
 }else if(view==='movements'){
  stats=stat('Wareneingangszeilen',rows.filter(r=>r.kind==='Wareneingang').length,'einschließlich Korrekturen')+stat('Umlagerungszeilen',rows.filter(r=>r.kind==='Umlagerung').length,'als Bewegung gebucht')+stat('Mengenprüffälle',rows.filter(r=>r.qty===null||r.qty<0).length,'getrennt nachvollziehbar');
  headers=['Datum','Artikel','Bewegungsart','Von → nach','Menge','Beleg / Hinweis','Aktion'];
  cells=rows.map(r=>[date(r.date),articleCell(r.article),badge(r.kind,r.kind==='Wareneingang'?'good':'info'),`${esc(r.from)}<small>→ ${esc(r.to)}</small>`,r.qty===null?badge('Fehlt','warn'):`<strong>${r.qty>0?'+':''}${r.qty}</strong>`,`${esc(r.doc)}<small>${esc(r.quality)}</small>`,`<button data-movement="${r.id}">Details</button>`]);
 }else if(view==='counts'){
  stats=stat('Inventuren',rows.length,'mit gezählten Positionen')+stat('Differenzpositionen',rows.reduce((s,r)=>s+r.plus+r.minus,0),'Fehl- und Mehrmengen')+stat('Unvollständige Mengen',rows.reduce((s,r)=>s+r.check,0),'gesondert zu prüfen');
  headers=['Datum','Inventur','Filiale','Positionen','Fehlmenge','Mehrmenge','Prüffälle','Aktion'];
  cells=rows.map(r=>[date(r.date),`<strong>${r.id}</strong>`,esc(r.branch),r.total,r.minus+' Pos.',r.plus+' Pos.',r.check?badge(r.check+' offen','warn'):'—',`<button data-count="${r.id}">Differenzen</button>`]);
 }else{
  stats=stat('Handlungshinweise',rows.filter(r=>r.state!=='warn').length,'Entscheidung vorbereiten')+stat('Datenprüffälle',rows.filter(r=>r.state==='warn').length,'vor Bewertung klären')+stat('Verkaufszeitraum','90 Tage','21.06.–18.09.2026');
  headers=['Artikel','Filiale','Hinweis','Begründung','Aktion'];
  cells=rows.map(r=>[articleCell(r.article),esc(r.branch),badge(r.type,r.state),esc(r.reason),`<button data-suggestion="${r.id}">Begründung</button>`]);
 }
 target.innerHTML=`<div class="gp-stats">${stats}</div><div class="gp-results-head"><p>${rows.length} Ergebnisse · Beispieldaten</p><div class="gp-result-actions">${['movements','counts'].includes(view)?`<button data-sort aria-label="Nach Datum ${sortDesc?'aufsteigend':'absteigend'} sortieren">Datum ${sortDesc?'↓':'↑'}</button>`:''}<button data-reset>Filter zurücksetzen</button></div></div>${table(headers,cells)}`;
}
function openDetail(title,eyebrow,html){$('#detailTitle').textContent=title;$('#detailEyebrow').textContent=eyebrow;$('#detailBody').innerHTML=html;if(!$('#detail').open)$('#detail').showModal();}
function showArticle(id){const a=article(id);if(!a)return;
 openDetail(a.name,'Artikelreferenz · '+a.id,badge(a.status,a.state)+facts([['Artikelnummer',a.id],['Sortiment',a.group],['Herkunft',a.origin],[a.status==='Archiviert'?'Im Archiv gelöscht am':'Quellstand',a.date]])+
 (a.status==='Archiviert'?'<p class="gp-notice">Historische Referenz. Keine Aktivierung im aktuellen Artikelstamm. Preis und Umsatz bleiben beim ursprünglichen Beleg.</p>':a.state==='warn'?'<p class="gp-notice">Mehrere Referenzen passen zur Kennung. Die fachliche Zuordnung bleibt offen.</p>':'<p class="gp-note">Aktive Referenz aus dem übernommenen Artikelstamm.</p>')+`<div class="gp-actions"><button data-related="${a.id}" class="gp-primary">Warenbewegungen ansehen</button></div>`);
}
document.addEventListener('click',e=>{
 const b=e.target.closest('button');if(!b)return;
 if(b.dataset.view){view=b.dataset.view;filters={query:'',branch:'',kind:''};render();}
 if(b.hasAttribute('data-reset')){filters={query:'',branch:'',kind:''};render();}
 if(b.hasAttribute('data-sort')){sortDesc=!sortDesc;renderResults();}
 if(b.dataset.article)showArticle(b.dataset.article);
 if(b.dataset.related){$('#detail').close();view='movements';filters={query:b.dataset.related,branch:'',kind:''};render();$('#content').focus();}
 if(b.dataset.movement){const r=movements.find(v=>v.id===b.dataset.movement);openDetail(r.kind+' · '+r.id,'Warenbewegung · '+date(r.date),articleCell(r.article)+facts([['Menge',r.qty===null?'Nicht angegeben':r.qty],['Herkunft',r.from],['Ziel / Bestandsfiliale',r.to],['Bestellnummer',r.order],['Belegverweis',r.doc],['Datenstand','18.09.2026']])+`<p class="gp-notice">${r.kind==='Umlagerung'?'Die Bewegung ist gebucht. Ein gesondert bestätigter Empfang am Ziel ist in dieser Quelle nicht enthalten.':r.qty<0?'Negative Menge: Korrektur oder Rücknahme möglich. Der konkrete Grund ist aus der Quelle nicht gesichert.':'Bestellbezüge werden nur bei passender Artikel- und Belegzuordnung verbunden.'}</p><p class="gp-note">Beispielquelle: WEUM · Bewegung ${r.id}</p>`);}
 if(b.dataset.count){const r=counts.find(v=>v.id===b.dataset.count),items=countDetails[r.id];openDetail('Inventur '+r.id,r.branch+' · '+date(r.date),facts([['Gezählte Positionen',r.total],['Ohne Differenz',r.total-r.plus-r.minus-r.check],['Differenzpositionen',r.plus+r.minus],['Unvollständige Mengen',r.check]])+table(['Artikel','Vorher','Gezählt','Differenz'],items.map(([a,old,now,diff])=>[articleCell(a),old??'Unbekannt',now??'Unbekannt',diff===null?badge('Prüfen','warn'):(diff>0?'+':'')+diff]))+'<p class="gp-note">Kopf und Positionen gehören zum selben Beispielimport. Die unveränderten Einzelzählstände werden hier nicht gespeichert. Mengenabweichungen sind keine bestätigte Verlustbewertung.</p>');}
 if(b.dataset.suggestion){const r=suggestions.find(v=>v.id===b.dataset.suggestion);const body=r.id==='S-1'?'<div class="gp-breakdown"><div><h3>Filiale A</h3><strong>1 Stück Bestand</strong><small>6 Stück verkauft in 90 Tagen</small></div><div><h3>Filiale B</h3><strong>5 Stück Bestand</strong><small>1 Stück verkauft in 90 Tagen</small></div></div><p>Eine Versorgung aus Filiale B könnte vor einer Neubestellung sinnvoll sein.</p><p class="gp-notice">Reservierungen, offene Bestellungen und Mindestbestand sind in diesem Beispiel nicht geprüft. Deshalb wird noch keine Umlagerungsmenge empfohlen.</p>':r.id==='S-2'?'<p>Im Beispiel stehen 9 Stück in Filiale B einem Zeitraum von 90 Tagen ohne erfassten Verkauf gegenüber.</p><p class="gp-notice">Saison, neue Anlieferungen und reservierte Ware prüfen, bevor ein Abverkauf entschieden wird. Der letzte Zugang bestimmt nicht das Alter jedes lagernden Stücks.</p>':'<p class="gp-notice">Die Artikelkennung ist mehrdeutig. Ein Umlagerungs- oder Nachbestellvorschlag wäre derzeit nicht belastbar.</p>';
 openDetail(r.type,'Erklärbarer Hinweis · '+r.id,articleCell(r.article)+body+facts([['Bestand zum','18.09.2026'],['Verkaufszeitraum','21.06.–18.09.2026'],['Datenquellen','Trade_Daten · Kasse · WEUM'],['Ausführung','Manuelle fachliche Entscheidung']])+`<div class="gp-actions"><button data-related="${r.article}">Warenbewegungen ansehen</button></div>`);}
 if(b.hasAttribute('data-source-help'))openDetail('Benötigte Datenbanken','Datengrundlage',facts([['Artikelhistorie','Trade_Daten und WEUM'],['Warenbewegungen','WEUM; Bestelldaten für Belegverknüpfungen'],['Inventuren','InventurProtokoll und Artikelreferenzen'],['Handlungsvorschläge','Zeitlich passende Bestands-, Kassen- und Bewegungsdaten']])+'<p class="gp-note">Die Dateien werden später unter Einstellungen → Datenbankimporte hochgeladen und geprüft übernommen.</p>');
});
$('#close').onclick=()=>$('#detail').close();
$('#theme').onclick=()=>{const dark=$('#prototype').dataset.pageTheme!=='dark';$('#prototype').dataset.pageTheme=dark?'dark':'light';document.documentElement.dataset.activePageTheme=dark?'dark':'light';$('#theme').setAttribute('aria-pressed',String(dark));$('#theme').textContent=dark?'Helle Ansicht':'Dunkle Ansicht';};
$('#scenario').onchange=render;
$('[role=tablist]').onkeydown=e=>{if(!['ArrowLeft','ArrowRight','Home','End'].includes(e.key))return;e.preventDefault();const tabs=[...document.querySelectorAll('[role=tab]')],index=tabs.indexOf(document.activeElement);const n=e.key==='Home'?0:e.key==='End'?tabs.length-1:(index+(e.key==='ArrowRight'?1:-1)+tabs.length)%tabs.length;tabs[n].click();tabs[n].focus();};
render();
