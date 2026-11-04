'use strict';
const {SOURCE_TOLERANCE:S}=require('../statements/data-import-source-tolerance');
const CATALOG=Object.freeze([{statement:S.listSourceToleranceEvents,returning:false,
  sql:`SELECT id,run_id AS "runId",revision,actor_id AS "actorId",action,at FROM data_import_events
    WHERE run_id=$runId AND substr(action,1,33)='import.source-tolerance.accepted:' ORDER BY revision`}]);
module.exports={CATALOG};
