"use strict";

const LOAN_RETURN_POLICY_PERMISSION = "loans:return-policy:manage";
const GLOBAL_POLICY_ROLES = new Set(["hr", "admin", "it_admin", "developer"]);
const LOCAL_POLICY_ROLES = new Set(["manager", "department_manager"]);

class LoanReturnPolicyError extends Error {
  constructor(message, code, status = 400) {
    super(message);
    this.name = "LoanReturnPolicyError";
    this.code = code;
    this.status = status;
  }
}

function loanReturnPolicySettingKey(locationId) {
  const id = String(locationId || "").trim();
  if (!id || id.length > 80 || /[\u0000-\u001f\u007f]/.test(id)) {
    throw new LoanReturnPolicyError("Der Standort für die Rücknahmeregel fehlt.", "LOAN_RETURN_POLICY_LOCATION_INVALID");
  }
  return `loan_return_requires_witness:${id}`;
}

function loanReturnPolicyFromSettings(settings, locationId) {
  const value = settings?.[loanReturnPolicySettingKey(locationId)];
  // Only an absent setting implies the single-person default. Corrupt stored
  // values must not silently weaken a previously configured control.
  if (value !== undefined && value !== null && value !== "true" && value !== "false") {
    throw new LoanReturnPolicyError("Die gespeicherte Rücknahmeregel ist ungültig.", "LOAN_RETURN_POLICY_STORED_INVALID", 503);
  }
  return Object.freeze({ requiresWitness: value === "true" });
}

function normalizeLoanReturnPolicy(value, current = { requiresWitness: false }) {
  if (value === undefined) return Object.freeze({ requiresWitness: current.requiresWitness === true });
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).some((key) => key !== "requiresWitness")
    || typeof value.requiresWitness !== "boolean") {
    throw new LoanReturnPolicyError("Bitte eine gültige Rücknahmeregel auswählen.", "LOAN_RETURN_POLICY_INVALID");
  }
  return Object.freeze({ requiresWitness: value.requiresWitness });
}

function canManageLoanReturnPolicy(session) {
  if (!session || session.sessionKind === "organization" || session.isEmployee === false) return false;
  const role = String(session.role || "");
  if (!GLOBAL_POLICY_ROLES.has(role) && !LOCAL_POLICY_ROLES.has(role)) return false;
  return Array.isArray(session.permissions) && session.permissions.includes(LOAN_RETURN_POLICY_PERMISSION);
}

function loanReturnPolicyAllowsLocation(session, locationId) {
  if (!canManageLoanReturnPolicy(session)) return false;
  if (GLOBAL_POLICY_ROLES.has(session.role)) return true;
  return String(session.homeLocationId || "") === String(locationId || "") && Boolean(locationId);
}

function assertLoanReturnPolicyCompletion(policy, { witnessEmployeeNumber = "" } = {}) {
  if (policy?.requiresWitness === true && !String(witnessEmployeeNumber || "").trim()) {
    throw new LoanReturnPolicyError(
      "Für diesen Standort muss ein zweites Teammitglied die Rücknahme bestätigen.",
      "LOAN_RETURN_WITNESS_REQUIRED",
      409,
    );
  }
}

module.exports = {
  LOAN_RETURN_POLICY_PERMISSION,
  LoanReturnPolicyError,
  loanReturnPolicySettingKey,
  loanReturnPolicyFromSettings,
  normalizeLoanReturnPolicy,
  canManageLoanReturnPolicy,
  loanReturnPolicyAllowsLocation,
  assertLoanReturnPolicyCompletion,
};
