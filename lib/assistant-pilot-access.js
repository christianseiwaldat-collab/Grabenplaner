"use strict";

function employeeNumbers(value) {
  if (!Array.isArray(value) || value.length > 50) return null;
  if (value.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_-]{1,80}$/.test(id))) return null;
  if (new Set(value).size !== value.length) return null;
  return [...value].sort();
}
function fromEnv(value) {
  if (value === undefined || value === "") return [];
  return employeeNumbers(String(value).split(",").map(id => id.trim()));
}
function allows(actor, numbers) {
  if (!Array.isArray(numbers)) return false;
  if (!numbers.length) return true;
  return Boolean(actor && actor.sessionKind !== "organization" && actor.isEmployee !== false
    && typeof actor.employeeNumber === "string" && numbers.includes(actor.employeeNumber));
}

module.exports = { employeeNumbers, fromEnv, allows };
