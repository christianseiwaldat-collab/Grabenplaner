(function(root,factory){
  const api=factory(typeof module==='object'&&module.exports?require('./start-dashboard-workspace-preferences'):root.StartDashboardWorkspacePreferences);
  if(typeof module==='object'&&module.exports)module.exports=api;else root.PersonnelDashboardWorkspacePreferences=api;
})(typeof globalThis==='object'?globalThis:this,function(shared){
  'use strict';
  const KEY='personnel_dashboard_workspace_v1';
  const IDS=Object.freeze(['employees','positions','applications','workflows','learning','tasks','requests','timeTracking','costCenters','ruleDrafts','collectiveAgreements','vacations'].map(id=>'card:'+id));
  const COLORS=shared.COLORS,LIMITS=shared.LIMITS;
  const object=value=>value&&typeof value==='object'&&!Array.isArray(value)&&[Object.prototype,null].includes(Object.getPrototypeOf(value));
  const empty=()=>({version:1,order:[...IDS],fields:{}});
  function validate(value){
    const invalid=()=>{throw new TypeError('Die persönlichen Personal-Dashboard-Einstellungen sind ungültig.');};
    if(!object(value)||value.version!==1||!object(value.fields)||Object.keys(value).some(key=>!['version','order','fields'].includes(key)))invalid();
    const order=value.order===undefined?[...IDS]:value.order;
    if(!Array.isArray(order)||order.length!==IDS.length||new Set(order).size!==IDS.length||order.some(id=>!IDS.includes(id)))invalid();
    const fields={};
    for(const [id,source]of Object.entries(value.fields)){
      if(!IDS.includes(id)||!object(source)||Object.keys(source).some(key=>!['title','description','geometry','hidden','color'].includes(key)))invalid();
      const field={};
      if(Object.hasOwn(source,'color')){if(!COLORS.includes(source.color))invalid();field.color=source.color;}
      if(Object.hasOwn(source,'hidden')){if(typeof source.hidden!=='boolean')invalid();field.hidden=source.hidden;}
      if(Object.hasOwn(source,'title')){if(typeof source.title!=='string'||!source.title.trim()||source.title.trim().length>120||/[\u0000-\u001f\u007f]/.test(source.title))invalid();field.title=source.title.trim();}
      if(Object.hasOwn(source,'description')){if(typeof source.description!=='string'||source.description.length>400||/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(source.description))invalid();field.description=source.description.trim();}
      if(Object.hasOwn(source,'geometry')){
        if(!object(source.geometry)||Object.keys(source.geometry).length!==4)invalid();
        const geometry={};for(const [key,[min,max]]of Object.entries(LIMITS)){const n=source.geometry[key];if(!Number.isInteger(n)||n<min||n>max)invalid();geometry[key]=n===0?0:n;}field.geometry=geometry;
      }
      if(Object.keys(field).length)fields[id]=field;
    }
    return {version:1,order:[...order],fields};
  }
  function normalize(value){try{return validate(value);}catch{return empty();}}
  function migrate(source,legacy){
    if(source!==undefined&&source!==null)return normalize(source);
    const result=empty(),order=Array.isArray(legacy?.order)?legacy.order.map(id=>'card:'+id).filter(id=>IDS.includes(id)):[];
    result.order=[...new Set([...order,...IDS])];
    for(const id of Array.isArray(legacy?.hidden)?legacy.hidden:[]){if(IDS.includes('card:'+id))result.fields['card:'+id]={hidden:true};}
    return result;
  }
  function layout(value){const p=validate(value);return {version:1,order:p.order.map(id=>id.slice(5)),hidden:p.order.filter(id=>p.fields[id]?.hidden===true).map(id=>id.slice(5))};}
  return {KEY,IDS,COLORS,LIMITS,empty,validate,normalize,migrate,layout};
});
