"use strict";

const PROFILE = "grabenplaner-postgresql-v1";
const FORMAT = "grabenplaner-postgresql-runtime-binding-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateBinding(value) {
  if (!value || Object.keys(value).sort().join(",") !== "clusterId,environmentId,format,profile"
      || value.format !== FORMAT || value.profile !== PROFILE
      || !/^[1-9][0-9]{15,24}$/.test(value.clusterId || "")
      || !UUID.test(String(value.environmentId || "").replace(/^grabenplaner-pair-/, ""))
      || !String(value.environmentId).startsWith("grabenplaner-pair-")) {
    throw new Error("PG_RUNTIME_BINDING_INVALID");
  }
  return Object.freeze({ ...value });
}

module.exports = { FORMAT, PROFILE, validateBinding };
