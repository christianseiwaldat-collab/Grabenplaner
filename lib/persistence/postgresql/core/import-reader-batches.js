'use strict';
const {IMPORT_READER_BATCHES:B}=require('../../statements/import-reader-batches');
const {CORE_BOUNDARY_CATALOG}=require('../boundary/catalog');
const {importReaderBatch}=require('../import-reader-batches');
const CORE_IMPORT_READER_BATCH_CATALOG=Object.freeze(B.filter(entry=>entry.domain==='core')
 .map(entry=>importReaderBatch(entry,CORE_BOUNDARY_CATALOG.find(compiled=>compiled.statement===entry.source))));
module.exports={CORE_IMPORT_READER_BATCH_CATALOG};
