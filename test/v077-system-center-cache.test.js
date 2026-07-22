"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const { createSystemCenterTechnicalCache } = require("../lib/system-center-technical-cache");

test("v0.77: technische System-Center-Abfragen werden kurz gecacht und parallel dedupliziert", async () => {
  let now = 1_000;
  let fingerprint = "head-a";
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createSystemCenterTechnicalCache({
    ttlMs: 2_000,
    now: () => now,
    fingerprint: () => fingerprint,
    load: async () => {
      reads += 1;
      await gate;
      return { sequence: reads };
    },
  });

  const first = cache.read();
  const parallel = cache.read();
  release();
  assert.deepEqual(await first, { sequence: 1 });
  assert.deepEqual(await parallel, { sequence: 1 });
  assert.equal(reads, 1);
  assert.deepEqual(await cache.read(), { sequence: 1 });
  assert.equal(reads, 1);

  now += 2_001;
  assert.deepEqual(await cache.read(), { sequence: 2 });
  assert.equal(reads, 2);
});

test("v0.77: geaenderter RAS-Fingerprint und explizite Invalidierung umgehen den Kurzcache", async () => {
  let fingerprint = "head-a";
  let reads = 0;
  const cache = createSystemCenterTechnicalCache({
    ttlMs: 10_000,
    fingerprint: () => fingerprint,
    load: async () => ({ sequence: ++reads }),
  });

  assert.equal((await cache.read()).sequence, 1);
  fingerprint = "head-b";
  assert.equal((await cache.read()).sequence, 2);
  cache.invalidate();
  assert.equal((await cache.read()).sequence, 3);
});

test("v0.77: Invalidierung waehrend einer Abfrage gibt danach keinen alten Laufstatus aus", async () => {
  let reads = 0;
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const cache = createSystemCenterTechnicalCache({
    fingerprint: () => "head-a",
    load: async () => {
      reads += 1;
      if (reads === 1) await gate;
      return { sequence: reads };
    },
  });

  const beforeRun = cache.read();
  cache.invalidate();
  const afterRun = cache.read();
  release();
  assert.deepEqual(await beforeRun, { sequence: 1 });
  assert.deepEqual(await afterRun, { sequence: 2 });
  assert.equal(reads, 2);
});

test("v0.77: fehlgeschlagene technische Abfragen werden nicht gecacht", async () => {
  let reads = 0;
  const cache = createSystemCenterTechnicalCache({
    fingerprint: () => "head-a",
    load: async () => {
      reads += 1;
      if (reads === 1) throw new Error("temporary");
      return { ok: true };
    },
  });

  await assert.rejects(cache.read(), /temporary/);
  assert.deepEqual(await cache.read(), { ok: true });
  assert.equal(reads, 2);
});

test("v0.77: Server bindet den actor-freien Cache ein und invalidiert ihn nach einem Lauf", () => {
  const fs = require("node:fs");
  const path = require("node:path");
  const source = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  assert.match(source, /const systemCenterTechnicalCache = createSystemCenterTechnicalCache\(\{/);
  assert.match(source, /async function systemCenterPayload\(actor\) \{\s*const technical = await systemCenterTechnicalCache\.read\(\);/);
  assert.match(source, /const technicalDiagnostics = actor\.permissions[\s\S]{0,900}systemCenterControlCache\.read\(\)/);
  assert.match(source, /requestRecoveryAssuranceRun\(\{ requestId \}\);\s*systemCenterTechnicalCache\.invalidate\(\);\s*systemCenterControlCache\.invalidate\(\);/);
});
