'use strict';
const {SALES_ANALYTICS_PERMISSIONS:A}=require('../../../sales-analytics-access');
const {SALES_HISTORY_PERMISSIONS:H}=require('../../../sales-history-access');
const {CRM_PERMISSIONS:C}=require('../../../crm-access');
const permissions=[...new Set([...Object.values(A),...Object.values(H),...Object.values(C),...Object.values(require('../../../tradefoto-bestell/access').BESTELL_PERMISSIONS)])];
const array=v=>{if(Array.isArray(v))return v;try{const a=JSON.parse(v||'[]');return Array.isArray(a)?a:[];}catch{return [];}};
const globalRoles=new Set(['developer','it_admin','admin','hr']);
function scopes(value){return array(value).map(s=>({locationId:String(s?.locationId??s?.location_id??''),departmentId:Number(s?.departmentId??s?.department_id??0)||null})).filter(s=>s.locationId);}
// This deliberately projects only permissions relevant to reporting. The row
// already resolves role/position defaults, grants, denials and live scopes in Core.
function createPostgresqlReportPrincipalResolver({portalAccess,today}){
  return async employeeNumber=>{
    if(!employeeNumber||String(employeeNumber).trim().toLowerCase()==='local')return null;
    const row=await portalAccess.getReportPrincipal({employeeNumber,businessDate:today()});if(!row)return null;
    const denied=new Set(array(row.denied_permissions));
    const effective=row.role==='developer'?permissions:[...new Set([...array(row.permissions),...array(row.granted_permissions)])].filter(p=>permissions.includes(p)&&!denied.has(p));
    const explicitScopes=scopes(row.access_scopes);let resolved=explicitScopes;
    if(globalRoles.has(row.role))resolved=[];
    else if(!Number(row.access_scope_assignment_count||0)&&!explicitScopes.length&&(row.home_location_active===true||Number(row.home_location_active)===1)){
      const department=(row.preferred_department_active===true||Number(row.preferred_department_active)===1)?Number(row.preferred_department_id)||null:null;
      resolved=['location_planner','manager'].includes(row.role)?[{locationId:row.home_location_id,departmentId:null}]:department?[{locationId:row.home_location_id,departmentId:department}]:[];
    }
    return {sessionKind:'employee',isEmployee:true,employeeNumber:row.employee_number,accountId:null,role:row.role,homeLocationId:row.home_location_id,permissions:effective,permissionScopes:array(row.permission_scopes),explicitScopes,scopes:resolved,mustChangePassword:Boolean(row.must_change_password)};
  };
}
module.exports={createPostgresqlReportPrincipalResolver};
