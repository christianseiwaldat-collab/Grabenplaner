(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./gp-definitions-registry'):root.GpDefinitionsRegistry);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpDefinitions=api;
})(typeof window==='object'?window:globalThis,function(registry){
  'use strict';
  function mount(root,{canUse=()=>false,key=()=>'',loadWorkspaces=null,onExit=()=>{},api=null}={}){
    if(!root||!registry)throw new TypeError('Die GP-Definitionsübersicht benötigt einen Bereich und die Registry.');
    const doc=root.ownerDocument,handlers=[];let active=false,dead=false,actor='',topic='windows',standardTopic='windows',query='';
    const on=(element,type,listener)=>{element.addEventListener(type,listener);handlers.push(()=>element.removeEventListener(type,listener));};
    const node=(tag,text,className)=>{const value=doc.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value;};
    root.classList.add('gp-definitions-workspace');
    const toolbar=node('div',undefined,'gp-definitions-toolbar'),label=node('label'),input=node('input'),clear=node('button','Leeren','gp-definitions-clear');
    input.type='search';input.placeholder='Definitionen durchsuchen';input.maxLength=160;input.autocomplete='off';input.id='gpDefinitionsSearch';
    label.append(node('span','Standards durchsuchen'),input);clear.type='button';clear.hidden=true;clear.setAttribute('aria-label','Suche in den GP-Definitionen leeren');
    const counter=node('p',undefined,'gp-definitions-count');counter.setAttribute('role','status');counter.setAttribute('aria-live','polite');toolbar.append(label,clear,counter);
    const layout=node('div',undefined,'gp-definitions-layout'),nav=node('nav',undefined,'gp-definitions-topics'),content=node('div',undefined,'gp-definitions-content');
    const standardContent=node('div'),privateContent=node('div');standardContent.style.cssText='display:grid;gap:16px';privateContent.hidden=true;content.append(standardContent,privateContent);
    nav.setAttribute('aria-label','Developer-Bereiche');content.id='gpDefinitionsContent';
    const standardsGroup=node('div',undefined,'gp-definitions-menu-group'),standardsButton=node('button'),standardItems=node('div',undefined,'gp-definitions-menu-children');
    standardsButton.type='button';standardsButton.dataset.gpDefinitionSection='standards';standardItems.id='gpDefinitionsStandardTopics';standardItems.setAttribute('role','group');standardItems.setAttribute('aria-label','GP-Standards');
    const standardsIcon=node('span','≡','gp-definitions-topic-symbol');standardsIcon.setAttribute('aria-hidden','true');
    const standardsChevron=node('span','›','gp-definitions-menu-chevron');standardsChevron.setAttribute('aria-hidden','true');
    standardsButton.append(standardsIcon,node('span','GP-Standards'),standardsChevron);standardsButton.setAttribute('aria-controls',standardItems.id+' '+content.id);standardsGroup.append(standardsButton,standardItems);nav.append(standardsGroup);
    on(standardsButton,'click',()=>{if(!allowed())return;topic=standardTopic;render();});
    const buttons=new Map();
    const privateButtons=new Map(),privateGroups=new Map(),privateParents=new Map(),frames=new Map();let loadGeneration=0,loadedActor='',loadingActor='';
    function screenGeometry(frame){const win=doc.defaultView,v=win.visualViewport,scale=Number.parseFloat(win.getComputedStyle(doc.body).zoom)||1;Object.assign(frame.style,{left:(v?.offsetLeft||0)/scale+'px',top:(v?.offsetTop||0)/scale+'px',width:(v?.width||win.innerWidth)/scale+'px',height:(v?.height||win.innerHeight)/scale+'px'});}
    function frameScreen(frame,enabled){if(enabled){if(frame.dataset.gpScreenStyle===undefined){frame.dataset.gpScreenStyle=frame.style.cssText;frame.dataset.gpScreenOverflow=doc.documentElement.style.overflow;}doc.documentElement.style.overflow='hidden';frame.style.cssText='position:fixed;inset:auto;min-height:0;border:0;border-radius:0;z-index:50000';screenGeometry(frame);}else if(frame.dataset.gpScreenStyle!==undefined){frame.style.cssText=frame.dataset.gpScreenStyle;doc.documentElement.style.overflow=frame.dataset.gpScreenOverflow||'';delete frame.dataset.gpScreenStyle;delete frame.dataset.gpScreenOverflow;}}
    const resizeScreens=()=>{for(const frame of frames.values())if(frame.dataset.gpScreenStyle!==undefined)screenGeometry(frame);};on(doc.defaultView,'resize',resizeScreens);if(doc.defaultView.visualViewport){on(doc.defaultView.visualViewport,'resize',resizeScreens);on(doc.defaultView.visualViewport,'scroll',resizeScreens);}
    if(doc.defaultView.ResizeObserver){const observer=new doc.defaultView.ResizeObserver(resizeScreens);observer.observe(doc.body);handlers.push(()=>observer.disconnect());}
    on(doc.defaultView,'message',event=>{
      if(event.origin!==doc.defaultView.location.origin||!allowed())return;
      const source=[...frames.values()].find(frame=>event.source===frame.contentWindow);if(!source)return;
      if(event.data?.type==='gp-private-workspace-fullscreen'&&frames.get(topic)===source)frameScreen(source,event.data.active===true);
      if(event.data?.type==='gp-private-workspace-ready')source.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:allowed()&&frames.get(topic)===source},event.origin);
      if(event.data?.type==='gp-private-workspace-size'&&Number.isFinite(event.data.height)&&source.dataset.gpScreenStyle===undefined)source.style.height=Math.max(550,Math.min(2400,Math.ceil(event.data.height)+8))+'px';
      if(event.data?.type==='gp-private-workspace-exit'&&frames.get(topic)===source){frameScreen(source,false);onExit();}
      if(event.data?.type==='gp-private-workspace-navigate'){
        const id='private/'+String(event.data.id||''),target=frames.get(id);if(!target||frames.get(topic)!==source)return;
        topic=id;render();
        if(typeof event.data.prompt==='string'&&event.data.prompt.length<=3000)target.contentWindow.postMessage({type:'gp-private-workspace-prompt',prompt:event.data.prompt},event.origin);
      }
    });
    for(const item of [{id:'all',title:'Alle Themen',symbol:'≡'},...registry.topics]){
      const button=node('button');button.type='button';button.dataset.gpDefinitionTopic=item.id;button.setAttribute('aria-controls',content.id);
      const icon=node('span',item.symbol,'gp-definitions-topic-symbol');icon.setAttribute('aria-hidden','true');button.append(icon,node('span',item.title));buttons.set(item.id,button);standardItems.append(button);
      on(button,'click',()=>{if(!allowed())return;topic=standardTopic=item.id;render();});
    }
    const stamp=node('p','Registry · Version '+registry.VERSION+' · '+new Intl.DateTimeFormat('de-AT',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(registry.UPDATED+'T12:00:00Z')),'gp-definitions-version');
    const voiceContent=node('div');voiceContent.hidden=true;content.append(voiceContent);
    const voiceWorkspace=api&&doc.defaultView.GpVoiceAssistantSettings?.mount(voiceContent,{api,canUse,key});
    const voiceButtons=new Map();
    if(voiceWorkspace){
      const group=node('div',undefined,'gp-definitions-menu-group'),children=node('div',undefined,'gp-definitions-menu-children');
      children.id='gpDefinitionsVoiceTopics';children.setAttribute('role','group');children.setAttribute('aria-label','voice.assistants');
      for(const id of ['voice.assistants','portal.assistant']){
        const button=node('button',id);button.type='button';button.dataset.gpVoicePage=id;button.setAttribute('aria-controls',content.id);
        voiceButtons.set(id,button);if(id==='voice.assistants'){group.append(button);button.setAttribute('aria-expanded','true');button.setAttribute('aria-controls',content.id+' '+children.id);}else children.append(button);
        on(button,'click',()=>{if(!allowed())return;topic=id;render();});
      }
      group.append(children);nav.append(group);
    }
    nav.append(stamp);layout.append(nav,content);
    const note=node('p','Diese Definitionen gelten als GP-Standard für neue und überarbeitete Bereiche. Ältere Bereiche werden bei ihrer Überarbeitung an diesen Standard angepasst.','gp-definitions-scope-note');
    root.replaceChildren(toolbar,layout,note);
    const allowed=()=>!dead&&active&&Boolean(key())&&canUse();
    function clearPrivate(){
      for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}
      for(const group of privateGroups.values())group.remove();
      privateButtons.clear();privateGroups.clear();privateParents.clear();frames.clear();privateContent.replaceChildren();
    }
    function selectButton(button,selected,ancestor=false){
      button.setAttribute('aria-pressed',String(selected));button.classList.toggle('is-selected',selected);button.classList.toggle('is-active-ancestor',ancestor);
      if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
    }
    function render(){
      root.hidden=!allowed();if(!allowed()){
        voiceWorkspace?.suspend();voiceWorkspace?.synchronize();
        for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}
        if(!canUse()||!key()){standardContent.replaceChildren();clearPrivate();}
        return;
      }
      const isVoice=voiceButtons.has(topic),isPrivate=privateButtons.has(topic),isTool=isPrivate||isVoice;toolbar.hidden=isTool;note.hidden=isTool;standardItems.hidden=isTool;standardsButton.setAttribute('aria-expanded',String(!isTool));standardsButton.setAttribute('aria-pressed',String(!isTool));standardsButton.classList.toggle('is-active-ancestor',!isTool);
      for(const[id,button]of voiceButtons)selectButton(button,id===topic,id==='voice.assistants'&&topic==='portal.assistant');
      if(isVoice){
        for(const button of buttons.values())selectButton(button,false);
        for(const button of privateButtons.values())selectButton(button,false);
        for(const frame of frames.values()){frame.hidden=true;frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}
        standardContent.hidden=true;standardContent.style.display='none';privateContent.hidden=true;voiceWorkspace.activate(topic);return;
      }
      voiceWorkspace?.suspend();
      for(const[id,button]of privateButtons)selectButton(button,id===topic,privateParents.get(topic)===id);
      if(isPrivate){
        for(const button of buttons.values())selectButton(button,false);
        counter.textContent='Persönlicher Arbeitsbereich';clear.hidden=true;
        standardContent.hidden=true;standardContent.style.display='none';privateContent.hidden=false;for(const[id,frame]of frames){frame.hidden=id!==topic;if(id===topic&&!frame.getAttribute('src'))frame.src=frame.dataset.gpWorkspaceUrl;if(id!==topic)frameScreen(frame,false);frame.contentWindow?.postMessage({type:'gp-private-workspace-visibility',active:id===topic},doc.defaultView.location.origin);}return;
      }
      standardContent.hidden=false;standardContent.style.display='grid';privateContent.hidden=true;
      for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}
      const selected=registry.select({topic,query});
      for(const[id,button]of buttons)selectButton(button,id===topic);
      counter.textContent=selected.length+' von '+registry.topics.length+' Themen';clear.hidden=!query;
      standardContent.replaceChildren();
      for(const item of selected){
        const card=node('article',undefined,'gp-definition-card'),heading=node('header'),tag=node('span','GP-Standard','gp-definition-tag');
        const title=node('h2',item.title);title.id='gpDefinition-'+item.id;card.setAttribute('aria-labelledby',title.id);
        heading.append(tag,title,node('p',item.summary));card.append(heading);
        const rules=node('div',undefined,'gp-definition-rules');
        for(const[ index,rule]of item.rules.entries()){
          const row=node('section',undefined,'gp-definition-rule'),number=node('span',String(index+1).padStart(2,'0'),'gp-definition-rule-number');number.setAttribute('aria-hidden','true');
          const body=node('div');body.append(node('h3',rule.title),node('p',rule.text));row.append(number,body);rules.append(row);
        }
        card.append(rules);
        const footer=node('footer'),example=node('p');example.append(node('strong','Referenz im GP: '),doc.createTextNode(item.example));
        const references=node('details'),summary=node('summary','Quellcode-Referenzen'),list=node('ul');
        for(const path of item.references){const entry=node('li');entry.append(node('code',path));list.append(entry);}
        references.append(summary,list);footer.append(example,references);card.append(footer);standardContent.append(card);
      }
      if(!selected.length){const empty=node('p','Keine Definition gefunden. Suche leeren oder ein anderes Thema wählen.','gp-definitions-empty');empty.setAttribute('role','status');standardContent.append(empty);}
    }
    function synchronize(){
      const next=String(key()||'');if(actor!==next||!canUse()){
        actor=next;topic=standardTopic='windows';query='';input.value='';loadGeneration++;loadedActor='';loadingActor='';
        clearPrivate();standardContent.replaceChildren();
        voiceWorkspace?.reset();
      }
      render();
      if(allowed()&&loadWorkspaces&&loadedActor!==actor&&loadingActor!==actor){
        loadingActor=actor;const expectedActor=actor,generation=++loadGeneration;
        Promise.resolve().then(()=>loadWorkspaces()).then(items=>{
          if(dead||generation!==loadGeneration||actor!==expectedActor||!allowed()||String(key()||'')!==expectedActor)return;
          loadingActor='';if(!Array.isArray(items))return;loadedActor=actor;
          const candidates=items.slice(0,16);for(const item of [...candidates.filter(item=>!item?.parentId),...candidates.filter(item=>item?.parentId)]){
            if(!/^[a-z][a-z0-9-]{0,40}$/.test(item?.id||'')||typeof item.title!=='string'||item.title.length>80
              ||item.url!=='/api/portal/v1/private-workspaces/'+item.id+'/page'||privateButtons.has('private/'+item.id))continue;
            const parentId=typeof item.parentId==='string'?'private/'+item.parentId:'';
            if(item.parentId&&(!privateGroups.has(parentId)||privateParents.has(parentId)))continue;
            const id='private/'+item.id,button=node('button',item.title),frame=node('iframe');
            button.type='button';button.dataset.gpPrivateWorkspace=item.id;button.setAttribute('aria-controls',content.id);
            if(parentId){
              button.dataset.gpPrivateParent=item.parentId;button.setAttribute('aria-label',item.title+' · '+privateButtons.get(parentId).textContent);privateParents.set(id,parentId);
              const parentButton=privateButtons.get(parentId),group=privateGroups.get(parentId);let children=group.querySelector('.gp-definitions-menu-children');
              if(!children){children=node('div',undefined,'gp-definitions-menu-children');children.id='gpDefinitionsPrivate-'+item.parentId;children.setAttribute('role','group');children.setAttribute('aria-label',parentButton.textContent);group.append(children);parentButton.setAttribute('aria-expanded','true');parentButton.setAttribute('aria-controls',content.id+' '+children.id);}
              children.append(button);
            }else{
              const group=node('div',undefined,'gp-definitions-menu-group');group.append(button);privateGroups.set(id,group);nav.insertBefore(group,stamp);
            }
            frame.title=item.title;frame.dataset.gpWorkspaceUrl=item.url;frame.style.cssText='width:100%;height:calc(100dvh - 250px);min-height:550px;border:0;border-radius:12px';
            if(item.camera===true)frame.setAttribute('allow',"camera 'self'; fullscreen 'self'");
            on(frame,'load',()=>frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:allowed()&&frames.get(topic)===frame},doc.defaultView.location.origin));
            frame.setAttribute('referrerpolicy','no-referrer');frame.hidden=true;privateContent.append(frame);frames.set(id,frame);privateButtons.set(id,button);
            on(button,'click',()=>{if(!allowed())return;topic=id;render();});
          }
          render();
        }).catch(()=>{if(generation===loadGeneration)loadingActor='';/* An optional private module must not disturb the standards. */});
      }
    }
    on(input,'input',()=>{if(!allowed())return;query=input.value;topic=standardTopic='all';render();});
    on(clear,'click',()=>{if(!allowed())return;query='';input.value='';render();input.focus();});
    return {activate(){active=true;synchronize();},suspend(){active=false;if(loadingActor){loadGeneration++;loadingActor='';}render();},synchronize,
      destroy(){if(dead)return;active=false;voiceWorkspace?.reset();for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}dead=true;handlers.forEach(remove=>remove());root.replaceChildren();root.hidden=true;},
      get state(){return {active:allowed(),topic,standardTopic,query,actor};}};
  }
  return Object.freeze({mount});
});
