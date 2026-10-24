"use strict";
const {S}=require('../statements/workflow-studio');
const json=(alias,names)=>'json_object('+names.flatMap(n=>["'"+n+"'",alias+'.'+n]).join(', ')+') AS data';
const run=['id','process_id','process_revision','trigger_type','trigger_key','status','location_id','department_id','triggered_by','activation_count','resolved_at','created_at','updated_at'];
const step=['run_id','step_id','sort_order','status','activated_at','completed_at','completed_by','completion_note','completion_request_id','created_at','updated_at'];
module.exports={CATALOG:Object.freeze([
 Object.freeze({statement:S.listStudioRuns,sql:`SELECT ${json('r',run)} FROM custom_process_runs r WHERE r.trigger_type='manual_studio' AND r.id > $after ORDER BY r.id LIMIT $limit`,returning:false}),
 Object.freeze({statement:S.listStudioRunSteps,sql:`SELECT ${json('rs',step)} FROM custom_process_run_steps rs JOIN custom_process_runs r ON r.id=rs.run_id WHERE r.trigger_type='manual_studio' AND rs.run_id=$runId ORDER BY rs.sort_order LIMIT 31`,returning:false}),
 Object.freeze({statement:S.completedStudioOperation,sql:`SELECT ${json('rs',step)} FROM custom_process_run_steps rs JOIN custom_process_runs r ON r.id=rs.run_id WHERE r.trigger_type='manual_studio' AND rs.completion_request_id=$key LIMIT 2`,returning:false}),
])};
