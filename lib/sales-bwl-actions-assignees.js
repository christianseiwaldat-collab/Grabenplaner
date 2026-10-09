'use strict';
const C=require('./data-import-contract'),M=require('./sales-bwl-actions-model');
function createSalesBwlActionsAssignees({access,repositoryFor,readFirstName}) {
  return async function loadAssignees(fresh,locationId,executor) {
    const initial=M.authority(await fresh(executor));M.assertLocation(initial,locationId,{write:true});
    const work=async tx=>{
      const check=async()=>{const auth=M.authority(await fresh(tx));if(auth.identity!==initial.identity)C.fail('BWL_ACTIONS_FORBIDDEN',403);M.assertLocation(auth,locationId,{write:true});};
      await check();const repository=repositoryFor(tx),rows=await repository.listEmployees();
      // Filter before opening any protected personnel profile. Full names,
      // working hours, positions and other personnel fields never leave here.
      const eligible=rows.filter(row=>row.active===true&&String(row.home_location_id||'')===locationId);
      if(eligible.length>2000)C.fail('BWL_ACTIONS_LIMIT',413);
      const result=[];for(const row of eligible){await check();const value=await readFirstName(repository,row);const firstName=typeof value==='string'?value.trim().slice(0,120):'';result.push({employeeNumber:String(row.personnel_number),firstName});}
      await check();return result.sort((a,b)=>a.firstName.localeCompare(b.firstName,'de')||a.employeeNumber.localeCompare(b.employeeNumber,'de',{numeric:true}));
    };
    return executor?work(executor):access.transaction(work,{isolation:'serializable',readOnly:true});
  };
}
module.exports={createSalesBwlActionsAssignees};
