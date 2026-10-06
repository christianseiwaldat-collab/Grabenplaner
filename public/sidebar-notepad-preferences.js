(function(root,factory){
  'use strict';
  const api=factory();
  if(typeof module==='object'&&module.exports)module.exports=api;
  else root.SidebarNotepadPreferences=api;
})(typeof window==='object'?window:this,function(){
  'use strict';
  const KEY='sidebar_notepad_v1',MAX_TEXT=20000,MIN_HEIGHT=120,MAX_HEIGHT=4096,MIN_WIDTH=200,MAX_WIDTH=4096,DEFAULT_WIDTH=240;
  const empty=()=>({version:2,text:'',width:DEFAULT_WIDTH,height:240,open:false});
  function validate(value){
    if(!value||typeof value!=='object'||Array.isArray(value)
      ||![Object.prototype,null].includes(Object.getPrototypeOf(value))
      ||Object.keys(value).length!==(value.version===1?4:5)||Object.keys(value).some(key=>!['version','text','width','height','open'].includes(key))
      ||![1,2].includes(value.version)||typeof value.text!=='string'||value.text.length>MAX_TEXT
      ||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.text)
      ||!Number.isInteger(value.height)||value.height<MIN_HEIGHT||value.height>(value.version===1?1200:MAX_HEIGHT)||typeof value.open!=='boolean'
      ||value.version===1&&Object.hasOwn(value,'width')||value.version===2&&(!Number.isInteger(value.width)||value.width<MIN_WIDTH||value.width>MAX_WIDTH)){
      throw new TypeError('Bitte gültige Notizen mit höchstens 20.000 Zeichen und einer gültigen Größe übermitteln.');
    }
    return {version:2,text:value.text,width:value.version===1?DEFAULT_WIDTH:value.width,height:value.height,open:value.open};
  }
  // A damaged stored note must never become an apparently empty editable note.
  function parseStored(value){return value===undefined?empty():validate(typeof value==='string'?JSON.parse(value):value);}
  function isPersonalActor(actor){
    return Boolean(actor&&actor.sessionKind==='employee'&&actor.isEmployee===true
      &&(actor.accountType===undefined||actor.accountType==='employee')&&actor.active!==false&&!actor.mustChangePassword
      &&typeof actor.employeeNumber==='string'&&actor.employeeNumber.trim()
      &&!['local','system','data_subject'].includes(actor.employeeNumber.toLowerCase()));
  }
  return Object.freeze({KEY,MAX_TEXT,MIN_HEIGHT,MAX_HEIGHT,MIN_WIDTH,MAX_WIDTH,DEFAULT_WIDTH,empty,validate,parseStored,isPersonalActor});
});
