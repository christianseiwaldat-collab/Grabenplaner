"use strict";
const { RENAMES, rename, TABLES, INDEXES, TRIGGERS } = require("../../schema-definitions/personnel-learning-runs");

function ensureLearningRunsSchema(database) { for(const item of [...TABLES,...INDEXES,...TRIGGERS]) database.exec(item.sql); }
module.exports={RENAMES,rename,TABLES,INDEXES,TRIGGERS,ensureLearningRunsSchema};
