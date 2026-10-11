(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpDashboardBoards=api;
})(typeof window==='object'?window:this,function(){
  'use strict';
  let count=0;
  function mount(options){
    const {root,store,model}=options,doc=root.ownerDocument,win=doc.defaultView,id=++count;
    const bar=doc.createElement('div');bar.className='gp-dashboard-boardbar';
    bar.innerHTML='<div class="gp-dashboard-tabs" role="tablist" aria-label="Persönliche Dashboards"></div><div class="gp-dashboard-board-actions"><button type="button" class="secondary-button" data-dashboard-settings>Ansicht einrichten</button><button type="button" class="secondary-button" data-dashboard-add>Eigenes Feld</button></div><p class="gp-dashboard-save-state" role="status" aria-live="polite"></p><button type="button" class="secondary-button" data-dashboard-retry hidden>Erneut versuchen</button>';
    (root.querySelector(':scope > header,:scope > .personnel-dashboard-heading')||root.firstElementChild).after(bar);
    const settings=doc.createElement('dialog'),note=doc.createElement('dialog');
    for(const [dialog,suffix,title]of[[settings,'settings','Dashboard einrichten'],[note,'note','Eigenes Notizfeld']]){
      dialog.className='gp-dashboard-settings-dialog';dialog.dataset.gpWindowMode='workspace';
      dialog.dataset.gpWindowId=(options.scopeName||'start')+'-dashboard-'+suffix;
      dialog.setAttribute('aria-labelledby','gpDashboard'+suffix+id);
      const header=doc.createElement('header');header.innerHTML='<h3 id="gpDashboard'+suffix+id+'">'+title+'</h3><button type="button" data-dashboard-dialog-close aria-label="Fenster schließen">×</button>';
      dialog.append(header);
    }
    settings.insertAdjacentHTML('beforeend','<form data-dashboard-settings-form><label>Dashboard-Name<input name="dashboardName" maxlength="60" required></label><fieldset><legend>Felder einblenden</legend><p>Diese Auswahl gilt für die aktuelle Ansicht. Berechtigungen gelten weiterhin.</p><div class="gp-dashboard-field-choices" data-dashboard-field-choices></div></fieldset><p data-dashboard-error role="alert"></p><div class="gp-dashboard-dialog-actions"><button type="button" data-dashboard-dialog-close>Abbrechen</button><button type="submit" class="primary-button">Speichern</button></div></form>');
    note.insertAdjacentHTML('beforeend','<form data-dashboard-note-form><label>Feldtitel<input name="title" maxlength="120" required></label><label>Notiz<textarea name="text" maxlength="2000" rows="7"></textarea></label><p class="gp-dashboard-help">Das Feld wird nur in dieser Dashboard-Ansicht und für dein Konto angelegt.</p><p data-dashboard-error role="alert"></p><div class="gp-dashboard-dialog-actions"><button type="button" data-dashboard-dialog-close>Abbrechen</button><button type="submit" class="primary-button">Feld anlegen</button></div></form>');
    doc.body.append(settings,note);
    const tabs=bar.querySelector('[role="tablist"]'),form=settings.querySelector('form'),noteForm=note.querySelector('form'),removers=[];
    let context=null,identity='',session=null,board='',disposed=false;
    const on=(node,type,handler)=>{node.addEventListener(type,handler);removers.push(()=>node.removeEventListener(type,handler));};
    const capture=()=>({key:String(options.key()||''),session:options.sessionReference?.(),board:store.document.activeDashboard});
    const current=ticket=>!disposed&&options.canUse()&&ticket.key===String(options.key()||'')&&ticket.session===options.sessionReference?.()&&ticket.board===store.document.activeDashboard;
    function close(dialog){const focus=dialog.open&&dialog.contains(doc.activeElement);if(dialog.open)dialog.close();context=null;dialog.querySelector('[type="submit"]').disabled=false;if(focus&&options.canUse())bar.querySelector(dialog===note?'[data-dashboard-add]':'[data-dashboard-settings]')?.focus({preventScroll:true});}
    function closeAll(){close(settings);close(note);}
    function open(dialog){options.beforeChange?.();closeAll();context=capture();dialog.querySelector('[data-dashboard-error]').textContent='';win.GpWindow?.prepare?.(dialog);dialog.showModal();dialog.querySelector('input').focus({preventScroll:true});}
    function sync(){
      const next=capture();
      if(identity!==next.key||session!==next.session||board!==next.board||!options.canUse()){closeAll();identity=next.key;session=next.session;board=next.board;}
      const document=store.document,active=store.value;
      const previous=doc.activeElement?.dataset.dashboardTab;
      tabs.replaceChildren();
      for(const dashboard of document.dashboards){
        const button=doc.createElement('button');button.type='button';button.role='tab';button.dataset.dashboardTab=dashboard.id;
        button.id='gpDashboardTab'+id+dashboard.id;button.setAttribute('aria-selected',String(dashboard.id===document.activeDashboard));
        button.setAttribute('aria-controls',options.grid.id);button.tabIndex=dashboard.id===document.activeDashboard?0:-1;
        button.textContent=dashboard.name;button.disabled=!store.ready;tabs.append(button);
      }
      options.grid.setAttribute('role','tabpanel');options.grid.setAttribute('aria-labelledby','gpDashboardTab'+id+document.activeDashboard);
      if(previous)tabs.querySelector('[data-dashboard-tab="'+previous+'"]')?.focus({preventScroll:true});
      bar.hidden=!options.canUse();bar.querySelector('[data-dashboard-settings]').disabled=!store.ready;
      bar.querySelector('[data-dashboard-add]').disabled=!store.ready||(active.customFields?.length||0)>=20;
      bar.querySelector('.gp-dashboard-save-state').textContent=store.saving?'Wird gespeichert …':store.saveFailed?'Änderungen noch nicht gespeichert.':store.failed?'Einstellungen konnten nicht geladen werden.':store.ready?'Für dein Konto gespeichert':'Einstellungen werden geladen …';
      bar.querySelector('[data-dashboard-retry]').hidden=!(store.saveFailed||store.failed);
    }
    on(tabs,'click',event=>{
      const tab=event.target.closest('[data-dashboard-tab]');if(!tab||!store.ready||!options.canUse())return;
      options.beforeChange?.();void store.change(model.selectDashboard(store.document,tab.dataset.dashboardTab));
    });
    on(tabs,'keydown',event=>{
      if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)||!store.ready)return;
      event.preventDefault();const buttons=[...tabs.children],index=buttons.indexOf(doc.activeElement);
      const next=event.key==='Home'?0:event.key==='End'?buttons.length-1:(index+(event.key==='ArrowLeft'?-1:1)+buttons.length)%buttons.length;
      buttons[next]?.click();tabs.children[next]?.focus({preventScroll:true});
    });
    function openSettings(){
      if(!store.ready||!options.canUse())return;
      const current=store.document.dashboards.find(item=>item.id===store.document.activeDashboard);
      form.elements.dashboardName.value=current.name;
      const choices=form.querySelector('[data-dashboard-field-choices]');choices.replaceChildren();
      for(const field of options.fields.values())if(options.allowed(field)){
        const label=doc.createElement('label'),input=doc.createElement('input'),caption=doc.createElement('span');
        input.type='checkbox';input.dataset.dashboardChoice=field.id;input.checked=store.value.fields[field.id]?.hidden!==true;
        caption.textContent=field.title.textContent;label.append(input,caption);choices.append(label);
      }
      open(settings);
    }
    function openNote(){if(!store.ready||!options.canUse()||(store.value.customFields?.length||0)>=20)return;noteForm.reset();open(note);context.noteId='custom:'+win.crypto.randomUUID();}
    on(bar,'click',event=>{
      if(event.target.closest('[data-dashboard-retry]')){if(store.failed)void store.activate({retry:true});else void store.change(store.document);return;}
      if(!store.ready||!options.canUse())return;
      if(event.target.closest('[data-dashboard-settings]'))openSettings();
      else if(event.target.closest('[data-dashboard-add]'))openNote();
    });
    for(const dialog of[settings,note]){
      on(dialog,'click',event=>{if(event.target.closest('[data-dashboard-dialog-close]'))close(dialog);});
      on(dialog,'cancel',event=>{event.preventDefault();close(dialog);});
    }
    async function save(dialog,next){
      const ticket=context,signature=JSON.stringify([...dialog.querySelectorAll('input,textarea')].map(input=>[input.name||input.dataset.dashboardChoice,input.value,input.checked]));
      if(!ticket||!current(ticket)||!store.ready)return;
      dialog.querySelector('[type="submit"]').disabled=true;dialog.querySelector('[data-dashboard-error]').textContent='';
      let success=false;
      try{success=await store.change(next);}catch(error){if(current(ticket))dialog.querySelector('[data-dashboard-error]').textContent=error.message;}
      if(context!==ticket||!current(ticket)||!dialog.open)return;
      dialog.querySelector('[type="submit"]').disabled=false;
      const newer=JSON.stringify([...dialog.querySelectorAll('input,textarea')].map(input=>[input.name||input.dataset.dashboardChoice,input.value,input.checked]))!==signature;
      if(success&&!newer)close(dialog);
      else if(!dialog.querySelector('[data-dashboard-error]').textContent)dialog.querySelector('[data-dashboard-error]').textContent=success?'Gespeichert. Neuere Änderungen sind noch offen.':'Speichern fehlgeschlagen. Bitte erneut versuchen.';
    }
    on(form,'submit',event=>{
      event.preventDefault();if(!context||!current(context)||form.querySelector('[type="submit"]').disabled)return;
      try{
        let next=model.renameDashboard(store.document,context.board,form.elements.dashboardName.value),active=model.getBoard(next);
        for(const input of form.querySelectorAll('[data-dashboard-choice]')){
          const field=options.fields.get(input.dataset.dashboardChoice);if(!field||!options.allowed(field))continue;
          active.fields[field.id]={...active.fields[field.id],hidden:!input.checked};
        }
        void save(settings,model.setBoard(next,active));
      }catch(error){form.querySelector('[data-dashboard-error]').textContent=error.message;}
    });
    on(noteForm,'submit',event=>{
      event.preventDefault();if(!context||!current(context)||noteForm.querySelector('[type="submit"]').disabled)return;
      try{
        const source={id:context.noteId,title:noteForm.elements.title.value,text:noteForm.elements.text.value},active=store.value;
        if(active.customFields.some(field=>field.id===source.id)){
          active.customFields=active.customFields.map(field=>field.id===source.id?source:field);
          delete active.fields[source.id]?.title;
          void save(note,model.validate(active));
        }else void save(note,model.addCustomField(active,source));
      }catch(error){noteForm.querySelector('[data-dashboard-error]').textContent=error.message;}
    });
    return{sync,openSettings,openNote,close:closeAll,destroy(){disposed=true;closeAll();for(const remove of removers)remove();bar.remove();settings.remove();note.remove();}};
  }
  return{mount};
});
