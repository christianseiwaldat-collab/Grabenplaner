'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');

function applicationFixture(t, open) {
  const boundary = require('../lib/persistence/postgresql/boundary/application');
  const authorization = require('../lib/persistence/postgresql/core/application');
  const operations = require('../lib/persistence/postgresql/application-operations/access');
  const closed = [], reads = [];
  t.mock.method(boundary, 'openTwoDatabaseDevelopmentApplication', open);
  t.mock.method(authorization, 'openCoreDevelopmentApplication', async () => ({
    repositories: { portalAccess: {} }, close: async () => closed.push('authorization'),
  }));
  t.mock.method(operations, 'openCoreOperations', async () => ({
    prepare: sql => ({ get: async () => { reads.push(sql); return { ready: true }; } }),
    close: async () => closed.push('operations'),
  }));
  const modulePath = require.resolve('../lib/persistence/postgresql/application');
  const previous = require.cache[modulePath];
  delete require.cache[modulePath];
  t.after(() => { delete require.cache[modulePath]; if (previous) require.cache[modulePath] = previous; });
  const application = require(modulePath).openDeferredPostgresqlApplication({
    coreUrl: 'synthetic-core', salesUrl: 'synthetic-sales',
    readers: { coreUrl: 'synthetic-reader' }, authorize: () => true,
  });
  return { application, closed, reads };
}

test('PostgreSQL connection deadlines begin after synchronous application bootstrap', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let opens = 0;
  const fixture = applicationFixture(t, () => {
    opens++;
    return new Promise((resolve, reject) => {
      const deadline = setTimeout(() => reject(new Error('synthetic connection timeout')), 5000);
      queueMicrotask(() => {
        clearTimeout(deadline);
        resolve({ provider: {}, close: async () => fixture.closed.push('application') });
      });
    });
  });
  const { application } = fixture;
  const beforeBootstrapFinished = opens;
  const read = application.operations.prepare('synthetic read').get();
  read.catch(() => {});
  // Simulate the observed 84-second synchronous server load without waiting or
  // depending on machine speed. Network completion needs the event loop.
  t.mock.timers.tick(84000);
  await application.ready;
  assert.equal(beforeBootstrapFinished, 0);
  assert.equal(opens, 1);
  assert.deepEqual(await read, { ready: true });
  assert.deepEqual(fixture.reads, ['synthetic read']);
  await application.provider.close();
  assert.deepEqual(fixture.closed, ['application', 'operations', 'authorization']);
});

test('deferred PostgreSQL startup still rejects readiness and waiting operations on connection failure', async t => {
  const failure = new Error('synthetic database unavailable');
  let opens = 0;
  const { application, reads, closed } = applicationFixture(t, async () => { opens++; throw failure; });
  const ready = assert.rejects(application.ready, error => error === failure);
  const read = assert.rejects(application.operations.prepare('synthetic read').get(), error => error === failure);
  await Promise.all([ready, read]);
  assert.equal(opens, 1);
  assert.deepEqual(reads, []);
  assert.deepEqual(closed, []);
  await assert.rejects(application.provider.close(), { code: 'PERSISTENCE_CONNECTION_UNAVAILABLE' });
});
