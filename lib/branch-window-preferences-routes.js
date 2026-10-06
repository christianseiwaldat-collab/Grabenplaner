'use strict';
const C = require('./data-import-contract');
const {branchWindowContext, createBranchWindowPreferencesStore} = require('./branch-window-preferences-store');
function registerBranchWindowPreferencesRoutes(app, {access, vault, scopeId, requireSession, refreshSession, assertCsrf}) {
  const store = createBranchWindowPreferencesStore({access, vault, scopeId});
  const route = write => async (request, response) => {
    response.set({'Cache-Control':'private, no-store', Pragma:'no-cache', 'X-Content-Type-Options':'nosniff'});
    try {
      const context = branchWindowContext(requireSession(request));
      if (write) assertCsrf(request);
      C.exact(request.query, []);
      const assertFresh = async executor => {
        const current = branchWindowContext(await refreshSession(request, executor));
        if (current.identity !== context.identity) C.fail('BRANCH_WINDOWS_FORBIDDEN', 403);
      };
      await assertFresh();
      const value = write ? await store.save(context, request.body, {assertFresh}) : await store.get(context, {assertFresh});
      await assertFresh();
      response.json(value);
    } catch (error) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 500;
      const messages = {401:'Bitte erneut anmelden.', 403:'Die Fenstereinstellungen sind für dieses Konto nicht freigegeben.',
        428:'Bitte zuerst das Startpasswort ändern.', 409:'Die Fenstereinstellungen wurden in einem anderen Fenster geändert. Bitte die Seite neu laden.',
        422:'Bitte gültige Fenstereinstellungen übermitteln.', 503:'Die geschützten Fenstereinstellungen sind vorübergehend nicht verfügbar.'};
      response.status(status).json({code:status === 500 ? 'BRANCH_WINDOWS_FAILED' : error.code,
        error:messages[status] || 'Die Fenstereinstellungen konnten nicht gespeichert werden.'});
    }
  };
  const path = '/api/portal/v1/branch-window-preferences';
  app.get(path, route(false)); app.put(path, route(true));
}
module.exports = {registerBranchWindowPreferencesRoutes};
