'use strict';
const {A}=require('../statements/trade-annotations');
const TRADE_ANNOTATIONS_CATALOG=Object.freeze([
 {statement:A.epoch,returning:false,sql:'SELECT COALESCE(SUM(revision),0) AS revision FROM trade_annotations WHERE scope_id=$scopeId'},
 {statement:A.get,returning:false,sql:'SELECT id,scope_id AS "scopeId",kind,revision,payload FROM trade_annotations WHERE id=$id AND scope_id=$scopeId AND kind=$kind'},
 {statement:A.insert,returning:false,sql:'INSERT INTO trade_annotations(id,scope_id,kind,revision,payload) VALUES($id,$scopeId,$kind,$revision,$payload)'},
 {statement:A.update,returning:false,sql:'UPDATE trade_annotations SET revision=$revision,payload=$payload WHERE id=$id AND scope_id=$scopeId AND kind=$kind AND revision=$expectedRevision'},
]);
const TRADE_ANNOTATIONS_SCHEMA='CREATE TABLE IF NOT EXISTS trade_annotations(id TEXT PRIMARY KEY,scope_id TEXT NOT NULL,kind TEXT NOT NULL,revision INTEGER NOT NULL CHECK(revision>0),payload TEXT NOT NULL)';
module.exports={TRADE_ANNOTATIONS_CATALOG,TRADE_ANNOTATIONS_SCHEMA};
