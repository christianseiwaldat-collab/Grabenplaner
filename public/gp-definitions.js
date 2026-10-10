(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./gp-definitions-registry'):root.GpDefinitionsRegistry);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpDefinitions=api;
})(typeof window==='object'?window:globalThis,function(registry){
  'use strict';
  function mount(root,{canUse=()=>false,key=()=>'',loadWorkspaces=null}={}){
    if(!root||!registry)throw new TypeError('Die GP-Definitionsübersicht benötigt einen Bereich und die Registry.');
    const doc=root.ownerDocument,handlers=[];let active=false,dead=false,actor='',topic='windows',query='';
    const on=(element,type,listener)=>{element.addEventListener(type,listener);handlers.push(()=>element.removeEventListener(type,listener));};
    const node=(tag,text,className)=>{const value=doc.createElement(tag);if(text!==undefined)value.textContent=text;if(className)value.className=className;return value;};
    root.classList.add('gp-definitions-workspace');
    const toolbar=node('div',undefined,'gp-definitions-toolbar'),label=node('label'),input=node('input'),clear=node('button','Leeren','gp-definitions-clear');
    input.type='search';input.placeholder='Definitionen durchsuchen';input.maxLength=160;input.autocomplete='off';input.id='gpDefinitionsSearch';
    label.append(node('span','Standards durchsuchen'),input);clear.type='button';clear.hidden=true;clear.setAttribute('aria-label','Suche in den GP-Definitionen leeren');
    const counter=node('p',undefined,'gp-definitions-count');counter.setAttribute('role','status');counter.setAttribute('aria-live','polite');toolbar.append(label,clear,counter);
    const layout=node('div',undefined,'gp-definitions-layout'),nav=node('nav',undefined,'gp-definitions-topics'),content=node('div',undefined,'gp-definitions-content');
    const standardContent=node('div'),privateContent=node('div');standardContent.style.cssText='display:grid;gap:16px';privateContent.hidden=true;content.append(standardContent,privateContent);
    nav.setAttribute('aria-label','Themen der GP-Definitionen');content.id='gpDefinitionsContent';
    const buttons=new Map();
    const privateButtons=new Map(),frames=new Map();let loadGeneration=0,loadedActor='';
    function frameScreen(frame,enabled){if(enabled){if(frame.dataset.gpScreenStyle===undefined){frame.dataset.gpScreenStyle=frame.style.cssText;frame.dataset.gpScreenOverflow=doc.documentElement.style.overflow;}doc.documentElement.style.overflow='hidden';frame.style.cssText='position:fixed;inset:0;width:100vw;height:100dvh;min-height:0;border:0;border-radius:0;z-index:50000';}else if(frame.dataset.gpScreenStyle!==undefined){frame.style.cssText=frame.dataset.gpScreenStyle;doc.documentElement.style.overflow=frame.dataset.gpScreenOverflow||'';delete frame.dataset.gpScreenStyle;delete frame.dataset.gpScreenOverflow;}}
    on(doc.defaultView,'message',event=>{
      if(event.origin!==doc.defaultView.location.origin||!allowed())return;
      const source=[...frames.values()].find(frame=>event.source===frame.contentWindow);if(!source)return;
      if(event.data?.type==='gp-private-workspace-fullscreen'&&frames.get(topic)===source)frameScreen(source,event.data.active===true);
      if(event.data?.type==='gp-private-workspace-ready')source.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:allowed()&&frames.get(topic)===source},event.origin);
      if(event.data?.type==='gp-private-workspace-size'&&Number.isFinite(event.data.height)&&source.dataset.gpScreenStyle===undefined)source.style.height=Math.max(550,Math.min(2400,Math.ceil(event.data.height)+8))+'px';
      if(event.data?.type==='gp-private-workspace-navigate'){
        const id='private/'+String(event.data.id||''),target=frames.get(id);if(!target)return;
        topic=id;render();
        if(typeof event.data.prompt==='string'&&event.data.prompt.length<=3000)target.contentWindow.postMessage({type:'gp-private-workspace-prompt',prompt:event.data.prompt},event.origin);
      }
    });
    for(const item of [{id:'all',title:'Alle Themen',symbol:'≡'},...registry.topics]){
      const button=node('button');button.type='button';button.dataset.gpDefinitionTopic=item.id;button.setAttribute('aria-controls',content.id);
      const icon=node('span',item.symbol,'gp-definitions-topic-symbol');icon.setAttribute('aria-hidden','true');button.append(icon,node('span',item.title));buttons.set(item.id,button);nav.append(button);
      on(button,'click',()=>{if(!allowed())return;topic=item.id;render();});
    }
    const stamp=node('p','Registry · Version '+registry.VERSION+' · '+new Intl.DateTimeFormat('de-AT',{day:'2-digit',month:'2-digit',year:'numeric',timeZone:'UTC'}).format(new Date(registry.UPDATED+'T12:00:00Z')),'gp-definitions-version');
    nav.append(stamp);layout.append(nav,content);
    const note=node('p','Diese Definitionen gelten als GP-Standard für neue und überarbeitete Bereiche. Ältere Bereiche werden bei ihrer Überarbeitung an diesen Standard angepasst.','gp-definitions-scope-note');
    root.replaceChildren(toolbar,layout,note);
    const allowed=()=>!dead&&active&&Boolean(key())&&canUse();
    function render(){
      root.hidden=!allowed();if(!allowed()){
        for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}
        if(!canUse()||!key()){standardContent.replaceChildren();privateContent.replaceChildren();frames.clear();}
        return;
      }
      for(const[id,button]of privateButtons){button.setAttribute('aria-pressed',String(id===topic));button.classList.toggle('is-selected',id===topic);}
      if(privateButtons.has(topic)){
        for(const button of buttons.values()){button.setAttribute('aria-pressed','false');button.classList.remove('is-selected');}
        counter.textContent='Persönlicher Arbeitsbereich';clear.hidden=true;
        standardContent.hidden=true;standardContent.style.display='none';privateContent.hidden=false;for(const[id,frame]of frames){frame.hidden=id!==topic;if(id!==topic)frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:id===topic},doc.defaultView.location.origin);}return;
      }
      standardContent.hidden=false;standardContent.style.display='grid';privateContent.hidden=true;
      for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}
      const selected=registry.select({topic,query});
      for(const[id,button]of buttons){button.setAttribute('aria-pressed',String(id===topic));button.classList.toggle('is-selected',id===topic);}
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
        actor=next;topic='windows';query='';input.value='';loadGeneration++;loadedActor='';
        for(const button of privateButtons.values())button.remove();privateButtons.clear();frames.clear();standardContent.replaceChildren();privateContent.replaceChildren();
      }
      render();
      if(allowed()&&loadWorkspaces&&loadedActor!==actor){
        loadedActor=actor;const expectedActor=actor,generation=++loadGeneration;
        Promise.resolve().then(()=>loadWorkspaces()).then(items=>{
          if(dead||generation!==loadGeneration||actor!==expectedActor||!canUse()||String(key()||'')!==expectedActor||!Array.isArray(items))return;
          for(const item of items.slice(0,16)){
            if(!/^[a-z][a-z0-9-]{0,40}$/.test(item?.id||'')||typeof item.title!=='string'||item.title.length>80
              ||typeof item.url!=='string'||!/^\/api\/portal\/v1\/private-workspaces\/[a-z0-9-]+\/page$/.test(item.url))continue;
            const id='private/'+item.id,button=node('button',item.title),frame=node('iframe');
            button.type='button';button.dataset.gpPrivateWorkspace=item.id;button.setAttribute('aria-controls',content.id);
            if(typeof item.parentId==='string'&&privateButtons.has('private/'+item.parentId)){
              button.dataset.gpPrivateParent=item.parentId;button.style.cssText='margin-left:12px;padding-left:18px;border-left:2px solid currentColor;width:calc(100% - 12px)';
              button.setAttribute('aria-label',item.title+' · '+privateButtons.get('private/'+item.parentId).textContent);
            }
            frame.title=item.title;frame.src=item.url;frame.style.cssText='width:100%;height:calc(100vh - 250px);min-height:550px;border:0;border-radius:12px';
            if(item.camera===true)frame.setAttribute('allow',"camera 'self'; fullscreen 'self'");
            on(frame,'load',()=>frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:allowed()&&frames.get(topic)===frame},doc.defaultView.location.origin));
            frame.setAttribute('referrerpolicy','no-referrer');frame.hidden=true;privateContent.append(frame);frames.set(id,frame);privateButtons.set(id,button);nav.insertBefore(button,stamp);
            on(button,'click',()=>{if(!allowed())return;topic=id;render();});
          }
          render();
        }).catch(()=>{/* An optional private module must not disturb the standards. */});
      }
    }
    on(input,'input',()=>{if(!allowed())return;query=input.value;topic='all';render();});
    on(clear,'click',()=>{if(!allowed())return;query='';input.value='';render();input.focus();});
    return {activate(){active=true;synchronize();},suspend(){active=false;render();},synchronize,
      destroy(){if(dead)return;active=false;for(const frame of frames.values()){frameScreen(frame,false);frame.contentWindow.postMessage({type:'gp-private-workspace-visibility',active:false},doc.defaultView.location.origin);}dead=true;handlers.forEach(remove=>remove());root.replaceChildren();root.hidden=true;},
      get state(){return {active:allowed(),topic,query,actor};}};
  }
  return Object.freeze({mount});
});
