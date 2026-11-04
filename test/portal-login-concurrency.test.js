"use strict";

const test = require("node:test"), assert = require("node:assert/strict");
const { setImmediate: nextTurn } = require("node:timers/promises");
const { createApplicationRepositories } = require("../lib/persistence/application-repositories");
const { runLoginTransaction } = require("../lib/portal-login-security");
const { withFixture, NOW, NEW_HASH } = require("../test-support/security-audit/login-concurrency-fixture.cjs");

function gate() {
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const timeout = setTimeout(() => {
    release.resolve(); entered.reject(new Error("Synthetic concurrency gate was not reached within ten seconds"));
  }, 10000);
  timeout.unref();
  return { entered: entered.promise, open: () => { clearTimeout(timeout); release.resolve(); },
    hold: async () => { entered.resolve(); await release.promise; } };
}

for (const kind of ["sqlite", "postgresql"]) {
  test(`${kind}: atomic account locks, login success and credential reset`, {
    skip: kind === "postgresql" && !process.env.GP_CORE_MIGRATOR_URL,
    timeout: 150000,
  }, async t => withFixture(kind, async f => {
    for (const channel of ["browser", "organization", "mobile"]) {
      await t.test(`${channel}: eight overlapping failures reach exactly the threshold and preserve an active lock`, async () => {
        await f.reset(channel);
        const user = await f.snapshot(channel);
        const writes = await Promise.all(Array.from({ length: 8 }, () => f.failure(channel, user)));
        assert.equal(writes.reduce((n, r) => n + r.rowsAffected, 0), 5);
        const locked = await f.snapshot(channel);
        assert.equal(locked.failed_login_attempts, 5);
        assert.equal(locked.locked_until, "2026-10-18T12:15:00.000Z");
        assert.equal((await f.failure(channel, user, { now: new Date(NOW.getTime() + 1000) })).rowsAffected, 0);
        assert.equal((await f.snapshot(channel)).locked_until, locked.locked_until);
        assert.equal(await f.login(channel, user), "locked");
        assert.equal(await f.activeSessions(channel), 0);
      });

      await t.test(`${channel}: successful login resets failures; the next failure starts at one`, async () => {
        await f.reset(channel, { attempts: 4 });
        const user = await f.snapshot(channel);
        assert.equal(await f.login(channel, user), "accepted");
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 0);
        await f.failure(channel, user);
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 1);
        assert.equal(await f.activeSessions(channel), 1);
      });

      await t.test(`${channel}: in-flight failure waits for successful session commit and is not lost`, async () => {
        await f.reset(channel, { attempts: 4 });
        const user = await f.snapshot(channel), barrier = gate();
        const success = f.login(channel, user, { beforeCommit: barrier.hold });
        await barrier.entered;
        const failure = f.failure(channel, user);
        await nextTurn(); barrier.open();
        const [accepted, failed] = await Promise.all([success, failure]);
        assert.equal(accepted, "accepted");
        assert.equal(failed.rowsAffected, 1);
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 1);
      });

      await t.test(`${channel}: a concurrent threshold failure prevents a previously verified success`, async () => {
        await f.reset(channel, { attempts: 4 });
        const user = await f.snapshot(channel), barrier = gate();
        const failure = runLoginTransaction(f.provider, createApplicationRepositories, async repos => {
          await f.failure(channel, user, { repository: repos.portalAccess }); await barrier.hold();
        });
        await barrier.entered;
        const success = f.login(channel, user);
        await nextTurn(); barrier.open(); await failure;
        assert.equal(await success, "locked");
        assert.equal(await f.activeSessions(channel), 0);
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 5);
      });

      await t.test(`${channel}: reset wins against old in-flight failures and successes`, async () => {
        await f.reset(channel, { attempts: 4 });
        const old = await f.snapshot(channel), barrier = gate();
        const reset = f.passwordReset(channel, barrier.hold);
        await barrier.entered;
        const failure = f.failure(channel, old), success = f.login(channel, old);
        await nextTurn(); barrier.open();
        const [, failed, accepted] = await Promise.all([reset, failure, success]);
        assert.equal(failed.rowsAffected, 0);
        assert.equal(accepted, "changed");
        const current = await f.snapshot(channel);
        assert.equal(current.password_hash, NEW_HASH);
        assert.equal(current.failed_login_attempts, 0);
        assert.equal(current.locked_until, null);
        assert.equal(await f.activeSessions(channel), 0);
        assert.equal(await f.login(channel, current), "accepted");
      });

      await t.test(`${channel}: reset after login commit revokes the newly created session`, async () => {
        await f.reset(channel, { attempts: 3 });
        const old = await f.snapshot(channel), barrier = gate();
        const success = f.login(channel, old, { beforeCommit: barrier.hold });
        await barrier.entered;
        const reset = f.passwordReset(channel);
        await nextTurn(); barrier.open(); assert.equal(await success, "accepted"); await reset;
        assert.equal(await f.activeSessions(channel), 0);
        const current = await f.snapshot(channel);
        assert.equal(current.password_hash, NEW_HASH);
        assert.equal(current.failed_login_attempts, 0);
      });

      await t.test(`${channel}: reset after a threshold failure clears the committed lock`, async () => {
        await f.reset(channel, { attempts: 4 });
        const old = await f.snapshot(channel), barrier = gate();
        const failure = runLoginTransaction(f.provider, createApplicationRepositories, async repos => {
          await f.failure(channel, old, { repository: repos.portalAccess }); await barrier.hold();
        });
        await barrier.entered;
        const reset = f.passwordReset(channel);
        await nextTurn(); barrier.open(); await failure; await reset;
        const current = await f.snapshot(channel);
        assert.equal(current.password_hash, NEW_HASH);
        assert.equal(current.failed_login_attempts, 0);
        assert.equal(current.locked_until, null);
      });

      await t.test(`${channel}: simultaneous successes leave one active session for the same browser/device`, async () => {
        await f.reset(channel, { attempts: 3 });
        const old = await f.snapshot(channel);
        assert.deepEqual(await Promise.all(Array.from({ length: 4 }, () => f.login(channel, old))), Array(4).fill("accepted"));
        assert.equal(await f.activeSessions(channel), 1);
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 0);
      });

      await t.test(`${channel}: rollback of session creation preserves the prior failure count`, async () => {
        await f.reset(channel, { attempts: 3 });
        await assert.rejects(f.login(channel, await f.snapshot(channel), { failInsert: true }), /synthetic session failure/);
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 3);
        assert.equal(await f.activeSessions(channel), 0);
      });

      await t.test(`${channel}: rollback restores an existing session revoked by the failed login`, async () => {
        await f.reset(channel);
        const user = await f.snapshot(channel);
        assert.equal(await f.login(channel, user), "accepted");
        const target = f.target(channel);
        const previous = (await f.all(`SELECT id FROM ${target.sessionTable} WHERE revoked_at IS NULL`))[0].id;
        await f.failure(channel, user);
        await assert.rejects(f.login(channel, user, { failInsert: true }), /synthetic session failure/);
        assert.equal((await f.snapshot(channel)).failed_login_attempts, 1);
        const active = await f.all(`SELECT id FROM ${target.sessionTable} WHERE revoked_at IS NULL`);
        assert.deepEqual(active.map(row => row.id), [previous]);
      });

      await t.test(`${channel}: expired lock starts a new window and disabled accounts cannot be admitted`, async () => {
        await f.reset(channel, { attempts: 5, lockedUntil: "2026-10-18T11:59:59.000Z" });
        const old = await f.snapshot(channel);
        await f.failure(channel, old);
        const fresh = await f.snapshot(channel);
        assert.equal(fresh.failed_login_attempts, 1); assert.equal(fresh.locked_until, null);
        const target = f.target(channel);
        await f.execute(`UPDATE ${target.table} SET active=0 WHERE ${target.idColumn}=$1`, [target.id]);
        assert.equal(await f.login(channel, old), "changed");
        assert.equal((await f.failure(channel, old)).rowsAffected, 0);
        assert.equal(await f.activeSessions(channel), 0);
      });
    }
    await t.test("browser and native mobile requests share the employee counter", async () => {
      await f.reset("browser"); const user = await f.snapshot("browser");
      await Promise.all(Array.from({ length: 8 }, (_, n) => f.failure(n % 2 ? "browser" : "mobile", user)));
      assert.equal((await f.snapshot("mobile")).failed_login_attempts, 5);
      assert.equal(await f.login("browser", user), "locked");
      assert.equal(await f.login("mobile", user), "locked");
    });
  }));
}
