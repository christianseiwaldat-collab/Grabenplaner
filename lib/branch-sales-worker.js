'use strict';
const C = require('./data-import-contract');

// Called only through the private worker channel. The web runtime refreshes
// the actual organization session before dispatch and again before delivery.
async function executeBranchReceiptWork(runtime, input) {
  if (!['branch-receipt-search', 'branch-receipt-documents'].includes(input?.operation)) C.fail('IMPORT_FORBIDDEN', 403);
  return runtime.run(async () => input.session, workspace => {
    if (!workspace || workspace.sourceRevision !== input.sourceRevision) C.fail('IMPORT_HISTORY_RESULTS_CHANGED', 409);
    return input.operation === 'branch-receipt-search'
      ? workspace.receipts.search(input.query) : workspace.receipts.documents(input.query);
  });
}

module.exports = { executeBranchReceiptWork };
