(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SidebarNotepadPreferences=api;
})(typeof window==='object'?window:this,function(){
  'use strict';
  const KEY='sidebar_notepad_v1',MAX_TEXT=20000,MIN_HEIGHT=120,MAX_HEIGHT=1200;
  const empty=()=>({version:1,text:'',height:240,open:false});
  function validate(value){
    if(!value||typeof value!=='object'||Array.isArray(value)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
      ||Object.keys(value).length!==4||Object.keys(value).some(key=>!['version','text','height','open'].includes(key))
      ||value.version!==1||typeof value.text!=='string'||value.text.length>MAX_TEXT
      ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
      ||!Number.isInteger(value.height)||value.height<MIN_HEIGHT||value.height>MAX_HEIGHT||typeof value.open!=='boolean'){
      throw new TypeError('Bitte gültige Notizen mit höchstens 20.000 Zeichen und einer gültigen Höhe übermitteln.');
    }
    return {version:1,text:value.text,height:value.height,open:value.open};
  }
  // A damaged stored note must never become an apparently empty editable note.
  function parseStored(value){return value===undefined?empty():validate(typeof value==='string'?JSON.parse(value):value);}
  function isPersonalActor(actor){
    return Boolean(actor&&actor.sessionKind==='employee'&&actor.isEmployee===true
      &&(actor.accountType===undefined||actor.accountType==='employee')&&actor.active!==false&&!actor.mustChangePassword
      &&typeof actor.employeeNumber==='string'&&actor.employeeNumber.trim()
      &&!['local','system','data_subject'].includes(actor.employeeNumber.toLowerCase()));
  }
  return Object.freeze({KEY,MAX_TEXT,MIN_HEIGHT,MAX_HEIGHT,empty,validate,parseStored,isPersonalActor});
});
