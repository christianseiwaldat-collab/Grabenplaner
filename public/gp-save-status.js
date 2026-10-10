(function(root,factory){'use strict';const api=factory();if(typeof module==='object'&&module.exports)module.exports=api;else root.GpSaveStatus=api;})(typeof window==='object'?window:globalThis,function(){
  'use strict';
  const labels=Object.freeze({none:'',local:'Lokal · in dieser Sitzung',changed:'Geändert · noch nicht gespeichert',saving:'Speichert …',saved:'Gespeichert',error:'Speichern fehlgeschlagen'});
  function create({key,canUse=()=>true,persistence='confirmed',onState}={}){
    if(typeof key!=='function'||typeof canUse!=='function'||!['confirmed','session'].includes(persistence))throw TypeError('Speicherstatus benötigt Konto/Scope und Speicherart.');
    const session=persistence==='session',listeners=new Set(),tokens=new WeakSet();
    let owner='',epoch=0,revision=0,sequence=0,pending=null,state='none',error='',dead=false;
    const currentKey=()=>String(key()||''),allowed=()=>!dead&&canUse()===true;
    const snapshot=()=>Object.freeze({state,text:labels[state]+(state==='saving'&&pending&&revision!==pending.revision?' · neue Änderungen offen':''),error,busy:Boolean(pending),changed:state==='changed'||Boolean(pending&&revision!==pending.revision)});
    const publish=()=>{const value=snapshot();onState?.(value);for(const listener of listeners)listener(value);};
    function invalidate(){epoch++;owner=currentKey();revision=0;pending=null;error='';state=allowed()&&owner&&session?'local':'none';publish();}
    function sync(){if(owner!==currentKey()||(!allowed()&&(state!=='none'||pending)))invalidate();else if(session&&allowed()&&owner&&state==='none'){state='local';publish();}return allowed()&&Boolean(owner);}
    const accepts=token=>sync()&&tokens.has(token)&&pending===token&&token.owner===owner&&token.epoch===epoch;
    function changed(){if(!sync())return false;revision++;error='';state=session?'local':pending?'saving':'changed';publish();return true;}
    function begin(){if(!sync()||session||pending)return null;const token=Object.freeze({owner,epoch,revision,sequence:++sequence});tokens.add(token);pending=token;state='saving';error='';publish();return token;}
    function succeeded(token,{remaining=false}={}){if(!accepts(token))return false;pending=null;error='';state=revision!==token.revision||remaining===true?'changed':'saved';publish();return true;}
    function failed(token,reason){if(!accepts(token))return false;pending=null;state='error';error=typeof reason?.message==='string'?reason.message.slice(0,400):typeof reason==='string'?reason.slice(0,400):'';publish();return true;}
    function cancel(token){if(!accepts(token))return false;pending=null;error='';state=revision!==token.revision?'changed':'none';publish();return true;}
    function loaded(){if(!sync()||session||pending||revision!==0)return false;state='saved';error='';publish();return true;}
    invalidate();
    return Object.freeze({changed,begin,succeeded,failed,cancel,loaded,sync,invalidate,current:accepts,get state(){sync();return snapshot();},
      subscribe(listener){listeners.add(listener);listener(snapshot());return()=>listeners.delete(listener);},
      dispose(){dead=true;epoch++;pending=null;error='';state='none';publish();listeners.clear();}});
  }
  function mount(node,controller,{prefix=''}={}){if(!node)return()=>{};node.classList.add('gp-save-status');node.setAttribute('role','status');node.setAttribute('aria-live','polite');node.setAttribute('aria-atomic','true');
    return controller.subscribe(value=>{node.dataset.state=value.state;node.hidden=value.state==='none';node.textContent=String(prefix)+value.text;node.title=value.error||'';});}
  return Object.freeze({labels,create,mount});
});
