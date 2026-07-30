"use strict";

const MUTATION_QUIESCE_ERROR_CODES = Object.freeze({
  CONFIGURATION_INVALID: "PROTECTED_DOCUMENT_QUIESCE_CONFIGURATION_INVALID",
  ALREADY_ACTIVE: "PROTECTED_DOCUMENT_QUIESCE_ALREADY_ACTIVE",
  MUTATION_BLOCKED: "PROTECTED_DOCUMENT_MUTATION_QUIESCED",
  TIMEOUT: "PROTECTED_DOCUMENT_QUIESCE_TIMEOUT",
});

class MutationQuiesceError extends Error {
  constructor(code) {
    super("Die geschuetzte Dokumentmutation ist waehrend des Sicherungsfensters nicht verfuegbar.");
    this.name = "MutationQuiesceError";
    this.code = code;
  }
}

function quiesceError(code) {
  return new MutationQuiesceError(code);
}

function createProtectedDocumentMutationGate({
  timeoutMilliseconds = 30_000,
} = {}) {
  if (!Number.isSafeInteger(timeoutMilliseconds)
    || timeoutMilliseconds < 100
    || timeoutMilliseconds > 5 * 60 * 1000) {
    throw quiesceError(MUTATION_QUIESCE_ERROR_CODES.CONFIGURATION_INVALID);
  }
  let activeMutations = 0;
  let quiescing = false;
  const drainWaiters = new Set();

  function notifyDrain() {
    if (activeMutations !== 0) return;
    for (const resolve of drainWaiters) resolve();
    drainWaiters.clear();
  }

  async function runMutation(work) {
    if (typeof work !== "function") {
      throw quiesceError(MUTATION_QUIESCE_ERROR_CODES.CONFIGURATION_INVALID);
    }
    if (quiescing) {
      throw quiesceError(MUTATION_QUIESCE_ERROR_CODES.MUTATION_BLOCKED);
    }
    activeMutations += 1;
    try {
      return await work();
    } finally {
      activeMutations -= 1;
      notifyDrain();
    }
  }

  async function waitForDrain() {
    if (activeMutations === 0) return;
    let timer;
    await new Promise((resolve, reject) => {
      const complete = () => {
        clearTimeout(timer);
        drainWaiters.delete(complete);
        resolve();
      };
      drainWaiters.add(complete);
      timer = setTimeout(() => {
        drainWaiters.delete(complete);
        reject(quiesceError(MUTATION_QUIESCE_ERROR_CODES.TIMEOUT));
      }, timeoutMilliseconds);
    });
  }

  async function withQuiescedMutations(work) {
    if (typeof work !== "function") {
      throw quiesceError(MUTATION_QUIESCE_ERROR_CODES.CONFIGURATION_INVALID);
    }
    if (quiescing) {
      throw quiesceError(MUTATION_QUIESCE_ERROR_CODES.ALREADY_ACTIVE);
    }
    quiescing = true;
    try {
      await waitForDrain();
      return await work(Object.freeze({
        active: true,
        pendingMutations: activeMutations,
      }));
    } finally {
      quiescing = false;
    }
  }

  function status() {
    return Object.freeze({
      quiescing,
      activeMutations,
    });
  }

  return Object.freeze({
    runMutation,
    status,
    withQuiescedMutations,
  });
}

module.exports = {
  MUTATION_QUIESCE_ERROR_CODES,
  MutationQuiesceError,
  createProtectedDocumentMutationGate,
};
