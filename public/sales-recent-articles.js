(function(root,factory) { const api=factory(); if(typeof module==='object'&&module.exports)module.exports=api;else root.SalesRecentArticles=api; })(typeof window==='object'?window:this,function(){
  'use strict';
  function mount(options) {
    const doc=options.document || document, win=doc.defaultView, dock=options.dock;
    const host=doc.createElement('section');host.className='sales-recent-articles';host.hidden=true;
    host.setAttribute('aria-label','Zuletzt geöffnete Artikel');host.setAttribute('role','region');
    host.innerHTML='<header data-recent-title><strong tabindex="0">Letzte Artikel</strong><button type="button" data-recent-min title="Minimieren" aria-label="Letzte Artikel minimieren">−</button><button type="button" data-recent-close title="Schließen" aria-label="Letzte Artikel schließen">×</button></header><div data-recent-body><p>Deine zwölf zuletzt geöffneten Artikel.</p><button type="button" data-recent-order>Neueste zuerst</button><details><summary>Spalten auswählen &amp; anordnen</summary><div data-recent-columns></div></details><p data-recent-status role="status" aria-live="polite"></p><div class="recent-table-scroll"><table><thead></thead><tbody></tbody></table></div></div>';
    doc.body.append(host);const q=s=>host.querySelector(s),table=q('table'),head=q('thead'),body=q('tbody');
    let actor='',epoch=0,rows=[],prefs=null,open=false,controller=null,read=null,write=Promise.resolve(),writeController=null,layout=null,destroyed=false;
    const visits=new Set();
    const allowed=()=>!destroyed&&options.canUse()&&actor===String(options.key()||'');
    const active=()=>allowed()&&options.active?.()!==false;
    const available=()=>options.columns();
    const selected=()=>{const cols=available();return (prefs?.columns || ['articleNumber','description','retailGross','primaryIdentifier']).map(id=>cols.find(c=>c.id===id)).filter(Boolean);};
    const initialGeometry=()=>{const sidebar=doc.getElementById('mainSidebar'),rect=sidebar?.getBoundingClientRect(),scale=options.scale?.() || 1;
      return options.initialGeometry?.() || {x:rect?.width&&rect.right>0?Math.round(rect.right/scale+24):40,y:120,width:680,height:430,minimized:false};};
    const text=(tag,v)=>{const n=doc.createElement(tag);n.textContent=String(v??'–');return n;};
    function render() {
      const cols=selected();head.replaceChildren();const hr=doc.createElement('tr');head.append(hr);
      for(const col of cols){const th=doc.createElement('th'),button=text('button',col.label);button.type='button';button.dataset.recentSort=col.id;
        button.disabled=!prefs;th.setAttribute('aria-sort',prefs?.sort===col.id?(prefs.direction==='desc'?'descending':'ascending'):'none');
        const resize=text('button','');resize.type='button';resize.dataset.gpColumnResize=col.id;resize.setAttribute('aria-label',col.label+' Spaltenbreite');th.append(button,resize);hr.append(th);}
      body.replaceChildren();let visible=[...rows];
      if(prefs?.sort && prefs.sort!=='recent') visible.sort((a,b)=>{const l=a[prefs.sort],r=b[prefs.sort];if(l==null)return r==null?0:1;if(r==null)return -1;
        const numeric=available().find(col=>col.id===prefs.sort)?.price || /^(retail|internet|purchase)(Gross|Net)$/.test(prefs.sort);
        return (numeric&&Number.isFinite(Number(l))&&Number.isFinite(Number(r))?Number(l)-Number(r):String(l).localeCompare(String(r),'de-AT',{numeric:true}))*(prefs.direction==='desc'?-1:1);});
      for(const row of visible){const tr=doc.createElement('tr');tr.dataset.recentOpen=row.articleNumber;for(const col of cols){const td=doc.createElement('td');if(col.id==='articleNumber'){const b=text('button',row.articleNumber);b.type='button';b.dataset.recentOpen=row.articleNumber;td.append(b);}else td.textContent=options.cell?.(row,col.id)??String(row[col.id]??'–');tr.append(td);}body.append(tr);}
      const chooser=q('[data-recent-columns]');chooser.replaceChildren();
      const ids=[...cols.map(c=>c.id),...available().map(c=>c.id).filter(id=>!cols.some(c=>c.id===id))];
      for(const id of ids){const col=available().find(c=>c.id===id),row=doc.createElement('div'),label=doc.createElement('label'),input=doc.createElement('input');input.type='checkbox';input.dataset.recentColumn=id;input.checked=cols.some(c=>c.id===id);input.disabled=!prefs||id==='articleNumber';label.append(input,text('span',col.label));row.append(label);
        for(const [direction,symbol] of [[-1,'←'],[1,'→']]){const b=text('button',symbol);b.type='button';b.dataset.recentMove=id;b.dataset.direction=String(direction);b.setAttribute('aria-label',col.label+(direction<0?' nach links':' nach rechts'));b.disabled=!prefs||!input.checked||(direction<0?cols[0]?.id===id:cols.at(-1)?.id===id);row.append(b);}chooser.append(row);}
      q('[data-recent-order]').disabled=!prefs || prefs.sort==='recent';
      layout?.render();
    }
    function synchronize(){const key=String(options.key()||'');if(destroyed||key===actor&&options.canUse())return;
      epoch++;read?.abort();read=null;writeController?.abort();writeController=null;for(const request of visits)request.abort();visits.clear();
      actor=key;rows=[];prefs=null;open=false;host.hidden=true;controller?.destroy();controller=null;
      render();q('[data-recent-status]').textContent='';if(dock)dock.hidden=!active();}
    function persist(){if(!prefs||!active())return;const key=actor,ticket=epoch,snapshot=JSON.stringify(prefs);write=write.catch(()=>{}).then(async()=>{
      if(!allowed()||key!==actor||ticket!==epoch)return;const request=new AbortController();writeController=request;
      try{await options.api('/api/sales/articles/recent/preferences',{method:'PUT',body:snapshot,signal:request.signal});}
      catch(error){if(!request.signal.aborted&&allowed()&&ticket===epoch)q('[data-recent-status]').textContent='Tabelleneinstellungen konnten nicht gespeichert werden: '+error.message;}
      finally{if(writeController===request)writeController=null;}});return write;}
    async function load(){synchronize();if(!allowed())return;read?.abort();const c=new AbortController();read=c;const ticket=epoch;q('[data-recent-status]').textContent='Artikel werden geladen …';try{const data=await options.api('/api/sales/articles/recent',{signal:c.signal});if(c.signal.aborted||ticket!==epoch||!allowed())return;rows=data.articles||[];if(!prefs)prefs={...data.preferences};render();q('[data-recent-status]').textContent=rows.length?`${rows.length} Artikel`:'Noch keine Artikel geöffnet.';}catch(error){if(!c.signal.aborted&&ticket===epoch&&allowed())q('[data-recent-status]').textContent=error.message;}finally{if(read===c)read=null;}}
    async function show(intent={}){synchronize();if(!active())return;const ticket=epoch;open=true;await options.windowPreferences?.activate();if(!active()||!open||ticket!==epoch)return;
      if(!controller)controller=win.GpWindow.attach(host,{title:q('[data-recent-title]'),body:q('[data-recent-body]'),toggle:q('[data-recent-min]'),closeButton:q('[data-recent-close]'),
        bounds:options.bounds,scale:options.scale,geometry:options.windowPreferences?.value.windows['articles:recent']||initialGeometry(),minWidth:300,minHeight:180,
        canUse:active,change:g=>options.windowPreferences?.change('articles:recent',g),closeTarget:()=>dock,onClose(){open=false;host.hidden=true;}});
      controller.activate();if(intent.restore!==false)controller.restore();render();void load();}
    dock?.addEventListener('click',show);
    host.addEventListener('click',event=>{if(!active())return;const item=event.target.closest('[data-recent-open]');if(item&&rows.some(row=>row.articleNumber===item.dataset.recentOpen)){options.openArticle(item.dataset.recentOpen);return;}
      const b=event.target.closest('button');if(!b||!prefs||b.disabled)return;
      if(b.hasAttribute('data-recent-order')){prefs={...prefs,sort:'recent',direction:'asc'};render();persist();return;}
      if(b.dataset.recentSort){const sort=b.dataset.recentSort;prefs={...prefs,sort,direction:prefs?.sort===sort&&prefs?.direction==='asc'?'desc':'asc'};render();persist();}
      if(b.dataset.recentMove){const cols=selected().map(c=>c.id),i=cols.indexOf(b.dataset.recentMove),j=i+Number(b.dataset.direction);if(i>=0&&j>=0&&j<cols.length){[cols[i],cols[j]]=[cols[j],cols[i]];prefs={...prefs,columns:cols};render();persist();}}});
    host.addEventListener('change',event=>{const id=event.target.dataset.recentColumn;if(!id)return;
      if(!prefs||!active()||!available().some(col=>col.id===id)){render();return;}
      let cols=selected().map(c=>c.id);cols=event.target.checked?[...new Set([...cols,id])]:cols.filter(c=>c!==id||c==='articleNumber');if(!cols.length)cols=['articleNumber'];prefs={...prefs,columns:cols};render();persist();});
    layout=win.GrabenplanerTableLayout.attach(table,{columns:selected,widths:()=>prefs?.columnWidths||{},change:value=>{if(prefs&&active())prefs={...prefs,columnWidths:value};},allowedColumns:()=>available().map(c=>c.id),canResize:()=>Boolean(prefs)&&active(),persist});
    return {show,sync(){synchronize();if(dock)dock.hidden=!active();if(!active()){read?.abort();controller?.suspend();host.hidden=true;}else if(open)void show({restore:false});},
      async record(number){synchronize();if(!allowed())return;const key=actor,ticket=epoch,request=new AbortController();visits.add(request);
        try{await options.api('/api/sales/articles/recent',{method:'POST',body:JSON.stringify({articleNumber:number}),signal:request.signal});if(!request.signal.aborted&&key===actor&&ticket===epoch&&open&&active())void load();}
        catch(error){if(!request.signal.aborted&&ticket===epoch&&allowed())options.error?.(error);}finally{visits.delete(request);}},
      suspend(){read?.abort();controller?.suspend();host.hidden=true;},destroy(){destroyed=true;epoch++;read?.abort();writeController?.abort();for(const request of visits)request.abort();visits.clear();controller?.destroy();layout?.destroy();host.remove();dock?.removeEventListener('click',show);}};
  }
  return {mount};
});
