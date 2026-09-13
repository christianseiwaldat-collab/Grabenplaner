"use strict";

const fs = require("node:fs");
const net = require("node:net");
const SOCKET = "/run/grabenplaner-postgresql-control/control.sock";
const FORMAT = "grabenplaner-postgresql-lifecycle-v1";
const ACTIONS = Object.freeze(["backup", "restart", "shutdown", "vps-reboot"]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function validateRequest(value) {
  if (!value || Object.keys(value).sort().join(",") !== "action,format,requestId"
      || value.format !== FORMAT || !ACTIONS.includes(value.action) || !UUID.test(value.requestId || "")) {
    throw new Error("PG_LIFECYCLE_REQUEST_INVALID");
  }
  return value;
}

function available() {
  if (process.platform !== "linux" || process.getuid() === 0) return false;
  try {
    const parent = fs.lstatSync("/run/grabenplaner-postgresql-control");
    const socket = fs.lstatSync(SOCKET);
    return parent.isDirectory() && parent.uid === 0 && !(parent.mode & 0o022)
      && socket.isSocket() && socket.uid === 0 && !(socket.mode & 0o007)
      && fs.realpathSync(SOCKET) === SOCKET;
  } catch { return false; }
}

async function requestControl({ action, requestId }) {
  const request = validateRequest({ format: FORMAT, action, requestId });
  if (!available()) throw new Error("PG_LIFECYCLE_CONTROL_UNAVAILABLE");
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET);
    let bytes = 0, body = "", complete = false;
    const finish = (error, value) => {
      if (complete) return;
      complete = true;
      clearTimeout(timer);
      socket.destroy();
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("PG_LIFECYCLE_CONTROL_TIMEOUT")), 15000);
    socket.on("connect", () => socket.end(JSON.stringify(request) + "\n"));
    socket.on("error", () => finish(new Error("PG_LIFECYCLE_CONTROL_UNAVAILABLE")));
    socket.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4096) return finish(new Error("PG_LIFECYCLE_RESPONSE_INVALID"));
      body += chunk.toString("utf8");
      if (!body.includes("\n")) return;
      try {
        const value = JSON.parse(body.trim());
        if (value.format !== FORMAT || value.requestId !== requestId || value.action !== action
            || value.accepted !== true) throw new Error(value.code || "PG_LIFECYCLE_RESPONSE_INVALID");
        finish(null, value);
      } catch (error) { finish(error); }
    });
    socket.on("end", () => { if (!complete) finish(new Error("PG_LIFECYCLE_RESPONSE_INVALID")); });
  });
}

module.exports = { SOCKET, FORMAT, ACTIONS, validateRequest, available, requestControl };
