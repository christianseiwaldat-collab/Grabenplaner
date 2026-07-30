"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");

const {
  MUTATION_QUIESCE_ERROR_CODES,
  createProtectedDocumentMutationGate,
} = require("../lib/persistence/operations/mutation-quiesce");

test("DB Block 6: Quiesce wartet laufende Dokumentmutation ab und sperrt neue bis zum Backupende", async () => {
  const gate = createProtectedDocumentMutationGate({ timeoutMilliseconds: 2_000 });
  let releaseMutation;
  const mutation = gate.runMutation(() => new Promise((resolve) => {
    releaseMutation = resolve;
  }));
  assert.deepEqual(gate.status(), { quiescing: false, activeMutations: 1 });

  let backupEntered = false;
  let releaseBackup;
  const backup = gate.withQuiescedMutations(async (evidence) => {
    backupEntered = true;
    assert.deepEqual(evidence, { active: true, pendingMutations: 0 });
    await new Promise((resolve) => {
      releaseBackup = resolve;
    });
    return "backup-complete";
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backupEntered, false);
  await assert.rejects(
    gate.runMutation(async () => {}),
    (error) => error?.code === MUTATION_QUIESCE_ERROR_CODES.MUTATION_BLOCKED,
  );

  releaseMutation("mutation-complete");
  assert.equal(await mutation, "mutation-complete");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(backupEntered, true);
  assert.deepEqual(gate.status(), { quiescing: true, activeMutations: 0 });
  releaseBackup();
  assert.equal(await backup, "backup-complete");
  assert.deepEqual(gate.status(), { quiescing: false, activeMutations: 0 });
  assert.equal(await gate.runMutation(async () => "next"), "next");
});

test("DB Block 6: verschachteltes Quiesce und Drain-Timeout scheitern geschlossen", async () => {
  const gate = createProtectedDocumentMutationGate({ timeoutMilliseconds: 100 });
  await gate.withQuiescedMutations(async () => {
    await assert.rejects(
      gate.withQuiescedMutations(async () => {}),
      (error) => error?.code === MUTATION_QUIESCE_ERROR_CODES.ALREADY_ACTIVE,
    );
  });

  let release;
  const mutation = gate.runMutation(() => new Promise((resolve) => {
    release = resolve;
  }));
  await assert.rejects(
    gate.withQuiescedMutations(async () => {}),
    (error) => error?.code === MUTATION_QUIESCE_ERROR_CODES.TIMEOUT,
  );
  assert.deepEqual(gate.status(), { quiescing: false, activeMutations: 1 });
  release();
  await mutation;
});
