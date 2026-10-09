(function(root,factory){
  'use strict';
  const api=factory(typeof module==='object'&&module.exports?require('./gp-definitions-registry'):root.GpDefinitionsRegistry);
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.GpDefinitions=api;
})(typeof window==='object'?window:globalThis,function(registry){
  'use strict';
  function mount(root,{canUse=()=>false,key=()=>''}={}){
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
    nav.setAttribute('aria-label','Themen der GP-Definitionen');content.id='gpDefinitionsContent';
    const buttons=new Map();
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
      root.hidden=!allowed();if(!allowed()){content.replaceChildren();return;}
      const selected=registry.select({topic,query});
      for(const[id,button]of buttons){button.setAttribute('aria-pressed',String(id===topic));button.classList.toggle('is-selected',id===topic);}
      counter.textContent=selected.length+' von '+registry.topics.length+' Themen';clear.hidden=!query;
      content.replaceChildren();
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
        references.append(summary,list);footer.append(example,references);card.append(footer);content.append(card);
      }
      if(!selected.length){const empty=node('p','Keine Definition gefunden. Suche leeren oder ein anderes Thema wählen.','gp-definitions-empty');empty.setAttribute('role','status');content.append(empty);}
    }
    function synchronize(){
      const next=String(key()||'');if(actor!==next||!canUse()){actor=next;topic='windows';query='';input.value='';}
      render();
    }
    on(input,'input',()=>{if(!allowed())return;query=input.value;topic='all';render();});
    on(clear,'click',()=>{if(!allowed())return;query='';input.value='';render();input.focus();});
    return {activate(){active=true;synchronize();},suspend(){active=false;render();},synchronize,
      destroy(){if(dead)return;active=false;dead=true;handlers.forEach(remove=>remove());root.replaceChildren();root.hidden=true;},
      get state(){return {active:allowed(),topic,query,actor};}};
  }
  return Object.freeze({mount});
});
