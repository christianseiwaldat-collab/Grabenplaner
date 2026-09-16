"use strict";
const { assertPersistenceAccess } = require("../contract");
const { DATA_IMPORT_STATEMENTS: S } = require("../statements/data-import");
const { fail } = require("../../data-import-contract");
const { IMPORT_BATCHES: B } = require('../statements/import-batches');
const REPOSITORIES = new WeakSet();
function createDataImportRepository(access) {
  assertPersistenceAccess(access);
  if (typeof access.transaction !== "function") fail("IMPORT_ATOMIC_STORAGE_REQUIRED");
  const repository = Object.freeze({
    atomic(work, {readOnly=false}={}) {
      return access.transaction(async executor => {
        const methods = {};
        for (const [name, statement] of Object.entries(S)) methods[name] = parameters => executor[statement.operation](statement, parameters);
        if (require('./import-batch-support').supportsImportBatches(access)) {
          require('./import-reader-cache').start(executor,require('./import-batch-support').supportsCoreImportReferences(access));
          const blocks = new Map(), links = new Map(), refs = new Map();
          const originalGet = methods.getPayloadBlock;
          methods.getPayloadBlock = async ({id}) => {
            if (!blocks.has(id)) blocks.set(id, await originalGet({id}));
            return blocks.get(id);
          };
          const originalInsert = methods.insertPayloadBlock;
          methods.insertPayloadBlock = async input => { const result = await originalInsert(input); blocks.delete(input.id); return result; };
          methods.getPayloadBlocks = async keys => {
            if (!keys.length) return [];
            const found = await executor.queryAll(B.blocks, {keys});
            keys.forEach(id => blocks.set(id, null)); found.forEach(row => blocks.set(row.id, row));
            return found;
          };
          methods.insertPayloadBlocks = async rows => {
            const result = await executor.execute(B.insertBlocks, {rows});
            rows.forEach(row => blocks.delete(row.id)); return result;
          };
          const originalLink = methods.getLink, originalRefs = methods.getRowPayloadRefs;
          methods.getLink = input => links.has(input.id) ? links.get(input.id) : originalLink(input);
          methods.getRowPayloadRefs = input => refs.has(input.rowNumber) ? refs.get(input.rowNumber) : originalRefs(input);
          // These caches live only inside this serializable transaction. The
          // regular decoder still authenticates every root, block and reference.
          methods.prepareRead = async (runId, rows) => {
            const numbers = rows.map(row => row.rowNumber), keys = [...new Set(rows.map(row => row.identityHash).filter(Boolean))];
            if (!numbers.length) return;
            const foundRefs = await executor.queryAll(B.rowRefs, {runId, rows:numbers});
            numbers.forEach(number => refs.set(number, []));
            foundRefs.forEach(({rowNumber,slot,blockId}) => refs.get(rowNumber).push({slot,blockId}));
            await methods.getPayloadBlocks([...new Set(foundRefs.map(ref => ref.blockId))]);
            if (keys.length) {
              keys.forEach(id => links.set(id, null));
              (await executor.queryAll(B.links, {keys})).forEach(link => links.set(link.id, link));
            }
          };
          for (const name of ['insertLink','updateLink','deleteLink']) {
            const original = methods[name]; methods[name] = async input => { const result = await original(input); links.delete(input.id); return result; };
          }
          for (const name of ['insertRowPayloadRef','deleteRowPayloadRefs']) {
            const original = methods[name]; methods[name] = async input => { const result = await original(input); refs.delete(input.rowNumber); return result; };
          }
          methods.findIdentities = (runId, keys) => keys.length ? executor.queryAll(B.identities, {runId,keys}) : [];
          methods.insertRows = rows => executor.execute(B.insertRows, {rows});
          methods.updateRows = rows => executor.execute(B.updateRows, {rows});
          methods.markCreatesApplied = (runId, rows) => executor.execute(B.markCreatesApplied, {runId,rows});
          methods.insertLinks = async rows => { const result = await executor.execute(B.insertLinks, {rows}); rows.forEach(row => links.delete(row.id)); return result; };
          methods.insertChanges = rows => executor.execute(B.insertChanges, {rows});
          methods.insertChangeRefs = async (runId, rows) => {
            const values = rows.flatMap(row => row.refs.map(ref => ({runId,rowNumber:row.rowNumber,...ref})));
            if (values.length && (await executor.execute(B.insertChangeRefs, {rows:values})).rowsAffected !== values.length) fail('IMPORT_EVIDENCE_REFS_WRITE_INVALID');
          };
          methods.replaceRowRefs = async (runId, rows) => {
            await executor.execute(B.deleteRowRefs, {runId,rows:rows.map(row => row.rowNumber)});
            const values = rows.flatMap(row => row.refs.map(ref => ({runId,rowNumber:row.rowNumber,...ref})));
            if (values.length && (await executor.execute(B.insertRowRefs, {rows:values})).rowsAffected !== values.length) fail('IMPORT_EVIDENCE_REFS_WRITE_INVALID');
            rows.forEach(row => refs.delete(row.rowNumber));
          };
        }
        methods.expectOne = async (name, parameters) => {
          const result = await methods[name](parameters);
          if (result.rowsAffected !== 1) fail("IMPORT_CONCURRENT_CHANGE", 409);
        };
        // Writers must use this exact transaction; independent connections are forbidden.
        return work(Object.freeze(methods), executor);
      }, { isolation: "serializable",readOnly });
    },
  });
  REPOSITORIES.add(repository); return repository;
}
function assertDataImportRepository(repository) { if (!REPOSITORIES.has(repository)) fail("IMPORT_STORAGE_UNTRUSTED"); return repository; }
module.exports = { createDataImportRepository, assertDataImportRepository };
