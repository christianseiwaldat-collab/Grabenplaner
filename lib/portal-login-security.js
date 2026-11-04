"use strict";

const { setTimeout: delay } = require("node:timers/promises");

function loginFailureParameters(user, settings, now = new Date()) {
  const configuredMaximum = Number(settings.max_failed_login_attempts);
  const maximum = Number.isSafeInteger(configuredMaximum) && configuredMaximum > 0
    ? configuredMaximum : 5;
  const configuredMinutes = Number(settings.account_lock_minutes);
  const lockMinutes = Number.isFinite(configuredMinutes) && configuredMinutes > 0
    && configuredMinutes <= 525600 ? configuredMinutes : 15;
  return {
    employeeNumber: user.employee_number,
    accountId: user.account_id,
    expectedPasswordHash: user.password_hash,
    maximum,
    now: now.toISOString(),
    lockedUntil: new Date(now.getTime() + lockMinutes * 60000).toISOString(),
  };
}

// Retry only transactions which the provider explicitly reports as rolled back.
// The callback must contain database work only; send cookies/tokens after commit.
async function runLoginTransaction(provider, createRepositories, work) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await provider.transaction(executor => work(createRepositories(executor)), {
        isolation: "serializable",
      });
    } catch (error) {
      if (error?.code !== "PERSISTENCE_RETRYABLE_TRANSACTION" || attempt >= 5) throw error;
      await delay(2 ** attempt);
    }
  }
}

async function acceptVerifiedLogin(repository, { user, organization = false, now = new Date() }) {
  const input = {
    employeeNumber: user.employee_number,
    accountId: user.account_id,
    expectedPasswordHash: user.password_hash,
    now: now.toISOString(),
  };
  const result = organization
    ? await repository.markOrganizationLoginSuccess(input)
    : await repository.markEmployeeLoginSuccess(input);
  if (result.rowsAffected === 1) return "accepted";
  const current = organization
    ? await repository.getOrganizationLogin({ loginName: user.employee_number })
    : await repository.getEmployeeLogin({ loginName: user.employee_number });
  return current?.locked_until && new Date(current.locked_until) > now ? "locked" : "changed";
}

module.exports = { loginFailureParameters, runLoginTransaction, acceptVerifiedLogin };
