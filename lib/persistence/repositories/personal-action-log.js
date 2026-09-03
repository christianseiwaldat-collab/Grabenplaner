"use strict";

const crypto = require("node:crypto");
const {
  normalizeLegacyAuditListInput,
  normalizePersonalActionListInput,
  normalizePersonalActionReceiptInput,
} = require("../../personal-action-log");
const {
  PERSISTENCE_ERROR_CODES,
  PersistenceError,
  assertPersistenceAccess,
} = require("../contract");
const {
  PERSONAL_ACTION_LOG_STATEMENTS: S,
} = require("../statements/personal-action-log");

const REPOSITORIES = new WeakSet();

function invalidInput(operation) {
  return new PersistenceError(PERSISTENCE_ERROR_CODES.STATEMENT_INVALID, { operation });
}

function identifier(value, operation, maximumLength = 160) {
  const normalized = String(value || "").trim();
  if (!normalized || normalized.length > maximumLength
    || !/^[A-Za-z0-9][A-Za-z0-9._:@/-]*$/.test(normalized)) throw invalidInput(operation);
  return normalized;
}

function normalizedReceipt(value, operation) {
  try {
    return normalizePersonalActionReceiptInput(value);
  } catch {
    throw invalidInput(operation);
  }
}

function normalizedList(actorId, options, operation) {
  try {
    return normalizePersonalActionListInput(actorId, options);
  } catch {
    throw invalidInput(operation);
  }
}

function normalizedLegacyList(actorId, options, operation) {
  try {
    return normalizeLegacyAuditListInput(actorId, options);
  } catch {
    throw invalidInput(operation);
  }
}

async function persistReceipt(access, input) {
  const id = crypto.randomUUID();
  if (input.compensatesActionId !== null) {
    const source = await access.queryOne(S.getOwn, {
      actorId: input.actorId,
      id: input.compensatesActionId,
    });
    if (!source || source.compensatorKey === null) {
      throw invalidInput("personal-action-log-record-compensation");
    }
  }
  await access.execute(S.insert, { id, ...input });
  return access.queryOne(S.getOwn, { actorId: input.actorId, id });
}

function methodsFor(access) {
  return Object.freeze({
    record(value) {
      const input = normalizedReceipt(value, "personal-action-log-record");
      if (typeof access.transaction !== "function") return persistReceipt(access, input);
      return access.transaction(
        (executor) => persistReceipt(executor, input),
        { isolation: "serializable" },
      );
    },
    listOwn(actorId, options = {}) {
      const input = normalizedList(actorId, options, "personal-action-log-list-own");
      return access.queryAll(S.listOwn, input);
    },
    getOwn(actorId, id) {
      return access.queryOne(S.getOwn, {
        actorId: identifier(actorId, "personal-action-log-get-own", 120),
        id: identifier(id, "personal-action-log-get-own", 36),
      });
    },
    findCompensation(actorId, actionId) {
      return access.queryOne(S.findCompensation, {
        actorId: identifier(actorId, "personal-action-log-find-compensation", 120),
        compensatesActionId: identifier(
          actionId,
          "personal-action-log-find-compensation",
          36,
        ),
      });
    },
    listLegacyAuditForActor(actorId, options = {}) {
      const input = normalizedLegacyList(
        actorId,
        options,
        "personal-action-log-list-legacy-audit",
      );
      return access.queryAll(S.listLegacyAuditForActor, input);
    },
  });
}

const createPersonalActionLogRepository = Object.freeze(function createPersonalActionLogRepository(
  access,
) {
  assertPersistenceAccess(access);
  const repository = Object.freeze({
    ...methodsFor(access),
    ...(typeof access.transaction === "function" ? {
      transaction(work, options) {
        if (typeof work !== "function") throw invalidInput("personal-action-log-transaction");
        return access.transaction(
          (executor) => work(createPersonalActionLogRepository(executor)),
          options,
        );
      },
    } : {}),
  });
  REPOSITORIES.add(repository);
  return repository;
});

function assertPersonalActionLogRepository(repository) {
  if (!REPOSITORIES.has(repository)) {
    throw new PersistenceError(PERSISTENCE_ERROR_CODES.CONTRACT_VIOLATION, {
      operation: "personal-action-log-repository",
    });
  }
  return repository;
}

module.exports = {
  assertPersonalActionLogRepository,
  createPersonalActionLogRepository,
};
