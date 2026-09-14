'use strict';
function ensureSqliteTradeAnnotationsSchema(db){db.exec(require('../trade-annotations-catalog').TRADE_ANNOTATIONS_SCHEMA);}
module.exports={ensureSqliteTradeAnnotationsSchema};
