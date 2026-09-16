'use strict';
const {IMPORT_READER_BATCHES:B}=require('../../statements/import-reader-batches');
const {SQLITE_APPLICATION_CATALOG}=require('../../sqlite/application-catalog');
const {compileSalesEntry}=require('./catalog');
const {importReaderBatch}=require('../import-reader-batches');
const IMPORT_READER_BATCH_CATALOG=Object.freeze(B.filter(entry=>entry.domain==='sales')
 .map(entry=>importReaderBatch(entry,compileSalesEntry(SQLITE_APPLICATION_CATALOG.find(e=>e.statement===entry.source),8).providerEntry)));
module.exports={IMPORT_READER_BATCH_CATALOG};
