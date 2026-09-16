'use strict';
const C = require('./data-import-contract');

// Display metadata only: never use a client-supplied name as a storage path.
function importFileName(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length > 1024) C.fail('IMPORT_SOURCE_FILENAME_INVALID');
  const name = value.split(/[\\/]/).at(-1).trim();
  if (!name || name.length > 255 || /[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/u.test(name) || !/\.accdb$/i.test(name)) C.fail('IMPORT_SOURCE_FILENAME_INVALID');
  return name;
}

function decodeImportFileName(value) {
  if (value === undefined) return null;
  if (typeof value !== 'string' || value.length > 4096) C.fail('IMPORT_SOURCE_FILENAME_INVALID');
  try { return importFileName(decodeURIComponent(value)); }
  catch { C.fail('IMPORT_SOURCE_FILENAME_INVALID'); }
}

module.exports = { importFileName, decodeImportFileName };
