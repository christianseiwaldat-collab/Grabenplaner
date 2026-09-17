"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const quote = value => "'" + String(value).replaceAll("'", "''") + "'";

// Exercise a permission change after the first session read, before the live
// mutation authorization. Far-future fixture sessions no longer renew on each
// request, so explicitly make this session due for renewal before arming it.
function installSessionTouchRaceMutation(database, auth, statements) {
  const trigger = "test_session_race_" + crypto.randomBytes(8).toString("hex");
  const expiry = new Date(Date.now() + 60_000).toISOString();
  assert.equal(database.prepare("UPDATE portal_sessions SET expires_at=? WHERE id=?")
    .run(expiry, auth.id).changes, 1);
  database.exec(`CREATE TRIGGER ${trigger} AFTER UPDATE OF expires_at ON portal_sessions
    WHEN NEW.id=${quote(auth.id)} BEGIN ${statements} END`);
  return () => {
    const session = database.prepare("SELECT expires_at FROM portal_sessions WHERE id=?").get(auth.id);
    database.exec(`DROP TRIGGER IF EXISTS ${trigger}`);
    assert.ok(session && session.expires_at !== expiry,
      "The request must reach the armed session-renewal race");
  };
}

module.exports = { installSessionTouchRaceMutation };
