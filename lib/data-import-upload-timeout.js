"use strict";

const { performance } = require("node:perf_hooks");

const DEFAULT_UPLOAD_TIMEOUT_MINUTES = 30;
const MIN_UPLOAD_TIMEOUT_MINUTES = 1;
const MAX_UPLOAD_TIMEOUT_MINUTES = 120;
const DEFAULT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const MINUTE_MS = 60 * 1000;
const requests = new WeakMap();
const installedServers = new WeakSet();

function validateUploadTimeoutMinutes(value) {
  if (!Number.isInteger(value) || value < MIN_UPLOAD_TIMEOUT_MINUTES || value > MAX_UPLOAD_TIMEOUT_MINUTES) {
    throw Object.assign(new Error("Das Upload-Zeitlimit muss eine ganze Zahl zwischen 1 und 120 Minuten sein."), {
      code: "IMPORT_UPLOAD_TIMEOUT_INVALID", status: 400,
    });
  }
  return value;
}

function timeoutError() {
  return Object.assign(new Error("Die Übertragung hat das persönliche Upload-Zeitlimit überschritten. Bitte das Zeitlimit erhöhen und die Datei erneut hochladen."), {
    code: "IMPORT_UPLOAD_TIMEOUT", status: 408,
  });
}

function cleanup(state) {
  clearTimeout(state.timer);
  state.request.removeListener("end", state.onDone);
  state.request.removeListener("aborted", state.onDone);
  state.request.removeListener("error", state.onDone);
  state.request.removeListener("close", state.onDone);
  requests.delete(state.request);
}

function expire(state) {
  cleanup(state);
  const { request, response } = state;
  if (request.complete || request.destroyed) return;
  const error = state.upload ? timeoutError() : {
    code: "REQUEST_TIMEOUT",
    message: "Die Anfrage wurde nicht rechtzeitig vollständig übertragen. Bitte erneut versuchen.",
  };
  // Let the 408 reach the client, then abort the unfinished body reader. Its
  // normal abort/finally path releases the upload admission and lifecycle gate.
  const destroyIncompleteRequest = () => { if (!request.complete) request.destroy(); };
  if (response.headersSent || response.writableEnded || response.destroyed) {
    destroyIncompleteRequest();
    return;
  }
  try {
    response.statusCode = 408;
    response.setHeader("Content-Type", "application/json; charset=utf-8");
    response.setHeader("Cache-Control", "private, no-store");
    response.setHeader("Connection", "close");
    response.once("finish", destroyIncompleteRequest);
    response.end(JSON.stringify({ code: error.code, error: error.message }));
  } catch {
    destroyIncompleteRequest();
  }
}

function schedule(state, budgetMs) {
  clearTimeout(state.timer);
  if (state.request.complete || state.request.destroyed) {
    cleanup(state);
    return true;
  }
  const remaining = state.startedAt + budgetMs - performance.now();
  if (remaining <= 0) {
    expire(state);
    return false;
  }
  state.timer = setTimeout(() => expire(state), remaining);
  state.timer.unref();
  return true;
}

function beginRequest(request, response, minuteMilliseconds = MINUTE_MS) {
  const state = { request, response, startedAt: performance.now(), minuteMilliseconds, upload: false, timer: null };
  state.onDone = () => cleanup(state);
  requests.set(request, state);
  request.once("end", state.onDone);
  request.once("aborted", state.onDone);
  request.once("error", state.onDone);
  request.once("close", state.onDone);
  return state;
}

function installImportUploadTimeouts(server, {
  // Scaled receive budgets let HTTP tests exercise real slow streams quickly.
  // Production calls this function without options.
  defaultRequestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  minuteMilliseconds = MINUTE_MS,
} = {}) {
  if (!Number.isFinite(defaultRequestTimeoutMs) || defaultRequestTimeoutMs <= 0
    || !Number.isFinite(minuteMilliseconds) || minuteMilliseconds <= 0) {
    throw new TypeError("Positive Empfangsfristen sind erforderlich.");
  }
  if (installedServers.has(server)) return server;
  installedServers.add(server);
  // Node's parser has a server-wide receive deadline. Keep a finite outer
  // bound while the listener below enforces each authenticated request's own
  // budget. Header and keep-alive protection retain their existing values.
  server.requestTimeout = MAX_UPLOAD_TIMEOUT_MINUTES * MINUTE_MS;
  server.prependListener("request", (request, response) => {
    if (request.complete || request.destroyed) return;
    schedule(beginRequest(request, response, minuteMilliseconds), defaultRequestTimeoutMs);
  });
  return server;
}

function armUploadRequest(request, response, minutes) {
  validateUploadTimeoutMinutes(minutes);
  // The whole body may already be received before asynchronous authorization
  // finishes. Processing and durable staging are not part of this deadline.
  if (request.complete) return;
  if (request.destroyed || response.writableEnded || response.destroyed) throw timeoutError();
  const state = requests.get(request) || beginRequest(request, response);
  state.upload = true;
  if (!schedule(state, minutes * state.minuteMilliseconds)) throw timeoutError();
}

module.exports = {
  DEFAULT_UPLOAD_TIMEOUT_MINUTES,
  MIN_UPLOAD_TIMEOUT_MINUTES,
  MAX_UPLOAD_TIMEOUT_MINUTES,
  DEFAULT_REQUEST_TIMEOUT_MS,
  validateUploadTimeoutMinutes,
  installImportUploadTimeouts,
  armUploadRequest,
};
