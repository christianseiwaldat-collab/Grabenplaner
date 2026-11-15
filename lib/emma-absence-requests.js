"use strict";

const { personalAbsenceRequestPeriod } = require("./absence-request-policy");
const PREFIX = "/api/portal/v1/emma/absence-requests";
const PENDING = new Set(["pending", "pending_local", "preliminary_local", "pending_hr"]);
const fail = (status, code, message) => Object.assign(new Error(message), { status, code });
const plain = value => value && typeof value === "object" && !Array.isArray(value);
const number = value => typeof value === "string" && /^[A-Za-z0-9._-]{1,24}$/.test(value);
const time = value => typeof value === "string" && /^([01]\d|2[0-3]):[0-5]\d$/.test(value);

async function authorizeEmmaAbsence({ request, input = null, repository, context = null,
  requireSession, loadSession, effectivePermissions, assertScope, today }) {
  const prior = requireSession(request, "absence_entries:write");
  const actor = await loadSession(request, { touch: false, repository: repository.portalAccess });
  if (!actor || actor.id !== prior.id || actor.sessionKind !== "employee" || actor.employeeNumber !== "Emma"
    || actor.mustChangePassword || !["schedule:read", "schedule:write", "absence_entries:write"].every(right => actor.permissions.includes(right))) {
    throw fail(403, "EMMA_ABSENCE_ACTOR_DENIED", "Der aktive Emma-Zugang hat keine Antragsberechtigung.");
  }
  if (!input) return actor;
  const row = await repository.portalAccess.getReportPrincipal({ employeeNumber: input.employeeNumber, businessDate: input.dateFrom || today() });
  const rights = row && effectivePermissions(row.employee_number, row.role, row.permissions,
    row.granted_permissions, row.denied_permissions, row.amu_local_access_mode).effectivePermissions;
  const required = input.kind === "vacation" ? ["own_vacation:read", "own_vacation:request"] : ["own_time:read", "own_time:write"];
  if (!row || !String(row.home_location_id || "").trim() || !rights || !required.every(right => rights.includes(right))) {
    throw fail(403, "EMMA_ABSENCE_SUBJECT_DENIED", "Für das Teammitglied ist dieser eigene Antrag nicht freigegeben.");
  }
  assertScope(actor, { locationId: row.home_location_id, departmentId: row.preferred_department_id });
  if (context) assertScope(actor, context);
  return actor;
}

function input(value, today, read = false) {
  const allowed = read ? ["employeeNumber", "kind", "id"]
    : ["employeeNumber", "kind", "dateFrom", "dateTo", "allDay", "startTime", "endTime", "note"];
  if (!plain(value) || Object.keys(value).some(key => !allowed.includes(key))
    || !number(value.employeeNumber) || !["vacation", "time_off"].includes(value.kind)) {
    throw fail(400, "EMMA_ABSENCE_INPUT_INVALID", "Bitte Art und Zeitraum des eigenen Antrags eindeutig angeben.");
  }
  if (read) {
    if (!Number.isSafeInteger(value.id) || value.id < 1) throw fail(400, "EMMA_ABSENCE_INPUT_INVALID", "Die Antragsnummer ist ungültig.");
    return { employeeNumber: value.employeeNumber, kind: value.kind, id: value.id };
  }
  const period = personalAbsenceRequestPeriod(value.dateFrom, value.dateTo, today, value.kind);
  if (period) throw fail(400, period.code, period.reason);
  if (typeof value.allDay !== "boolean" || value.kind === "vacation" && !value.allDay
    || value.allDay && (value.startTime != null || value.endTime != null)
    || !value.allDay && (value.dateFrom !== value.dateTo || !time(value.startTime) || !time(value.endTime) || value.startTime >= value.endTime)
    || value.note !== undefined && (typeof value.note !== "string" || value.note.length > 500 || /[\x00-\x1f\x7f]/.test(value.note))) {
    throw fail(400, "EMMA_ABSENCE_INPUT_INVALID", "Bitte ganztägigen Antrag oder ein vollständiges ZA-Zeitfenster angeben.");
  }
  return { employeeNumber: value.employeeNumber, kind: value.kind, dateFrom: value.dateFrom, dateTo: value.dateTo,
    allDay: value.allDay, startTime: value.allDay ? null : value.startTime, endTime: value.allDay ? null : value.endTime,
    note: (value.note || "").trim() };
}

function publicCheck(check) {
  if (!plain(check) || typeof check.allowed !== "boolean" || !["green", "yellow", "red"].includes(check.trafficLight)
    || typeof check.reason !== "string" || check.reason.length > 2000) throw fail(502, "EMMA_ABSENCE_CHECK_INVALID", "Die GP-Prüfung konnte nicht sicher gelesen werden.");
  return { allowed: check.allowed, trafficLight: check.trafficLight, manualReview: check.manualReview === true,
    reason: check.reason.replace(/[\x00-\x1f\x7f]/g, " "),
    ...(typeof check.code === "string" && /^[A-Z0-9_]{1,100}$/.test(check.code) ? { code: check.code } : {}) };
}

function publicRequest(row, kind) {
  if (!plain(row) || !Number.isSafeInteger(Number(row.id)) || Number(row.id) < 1 || !number(row.employee_number)
    || typeof row.status !== "string") throw fail(502, "EMMA_ABSENCE_READ_INVALID", "Der Antrag konnte nicht sicher gelesen werden.");
  const allDay = kind === "vacation" || row.all_day === true || row.all_day === 1;
  return { id: Number(row.id), kind, employeeNumber: row.employee_number, locationId: row.location_id,
    dateFrom: row.date_from || row.request_date, dateTo: row.date_to || row.request_date,
    allDay, startTime: allDay ? null : row.start_time, endTime: allDay ? null : row.end_time,
    status: PENDING.has(row.status) ? "pending" : row.status, nativeStatus: row.status,
    pending: PENDING.has(row.status), note: typeof row.note === "string" ? row.note : "" };
}

function batchInput(body, today) {
  if (!plain(body) || Object.keys(body).some(key => !["employeeNumber", "kind", "periods", "note"].includes(key))
    || !Array.isArray(body.periods) || body.periods.length < 1 || body.periods.length > 12) {
    throw fail(400, "EMMA_ABSENCE_INPUT_INVALID", "Bitte einen bis zwölf eindeutige Antragszeiträume angeben.");
  }
  const periods = body.periods.map(period => {
    if (!plain(period) || Object.keys(period).some(key => !["dateFrom", "dateTo", "allDay", "startTime", "endTime"].includes(key))) {
      throw fail(400, "EMMA_ABSENCE_INPUT_INVALID", "Bitte nur Datum und Zeitfenster angeben.");
    }
    return input({ ...period, employeeNumber: body.employeeNumber, kind: body.kind, note: body.note }, today);
  });
  for (let i = 0; i < periods.length; i++) for (let j = 0; j < i; j++) {
    const a = periods[i], b = periods[j];
    if (a.dateFrom <= b.dateTo && b.dateFrom <= a.dateTo && (a.allDay || b.allDay || a.startTime < b.endTime && b.startTime < a.endTime)) {
      throw fail(400, "EMMA_ABSENCE_PERIOD_OVERLAP", "Die eigenen Antragszeiträume überschneiden sich.");
    }
  }
  return periods;
}

// Dedicated service-actor workflow. It creates native pending request rows and
// native review notifications/decisions. It cannot approve, edit, withdraw, or
// create a confirmed vacation/week option. Authorization is reloaded inside
// the native transaction; the subject remains distinct from the Emma actor.
function createEmmaAbsenceRequests(deps) {
  const repo = deps.repository;
  const load = async (value, repository = repo) => {
    const row = await (value.kind === "vacation" ? repository.requestByIdVacation(value.id) : repository.requestByIdTimeOff(value.id));
    if (!row || row.employee_number !== value.employeeNumber) throw fail(404, "EMMA_ABSENCE_NOT_FOUND", "Der eigene Antrag wurde nicht gefunden.");
    return publicRequest(row, value.kind);
  };
  const assess = async (request, value, repository = repo) => {
    await deps.authorize(request, value, repository);
    const context = await deps.context(value, repository);
    const actor = await deps.authorize(request, value, repository, context);
    if (value.kind === "vacation" && await repository.vacationOverlap({ employeeNumber: value.employeeNumber,
      excludeId: 0, dateFrom: value.dateFrom, dateTo: value.dateTo })) {
      throw fail(409, "VACATION_REQUEST_OVERLAP", "Für diesen Zeitraum besteht bereits ein Urlaubsantrag.");
    }
    const check = publicCheck(await deps.evaluate(value, context, repository));
    await deps.authorize(request, value, repository, context);
    return { context, actor, check };
  };
  const assessPeriod = async (request, value, repository = repo) => {
    try { return await assess(request, value, repository); }
    catch (error) {
      if (![400, 409].includes(error.status)) throw error;
      return { check: publicCheck({ allowed: false, trafficLight: "red", code: error.code,
        reason: String(error.message || "Dieser Zeitraum kann nicht beantragt werden.") }) };
    }
  };
  return {
    async capabilities(request) {
      await deps.authorize(request);
      return { version: 1, pendingOnly: true, strictEligibility: true, atomicBatch: true, maxPeriods: 12, kinds: ["vacation", "time_off"] };
    },
    async check(request, body) {
      const periods = batchInput(body, deps.today()), checks = [];
      for (const value of periods) {
        const { check, context } = await assessPeriod(request, value);
        checks.push({ ...check, dateFrom: value.dateFrom, dateTo: value.dateTo, ...(context ? { locationId: context.locationId } : {}) });
      }
      return { allowed: checks.every(check => check.allowed), employeeNumber: body.employeeNumber, checks };
    },
    async submit(request, body) {
      const periods = batchInput(body, deps.today());
      await deps.authorize(request, periods[0]);
      return repo.transaction(async repository => {
        const results = [], blocked = [];
        for (const [index, value] of periods.entries()) {
        const { context, actor, check } = await assessPeriod(request, value, repository);
        if (!check.allowed) { blocked.push({ index, dateFrom: value.dateFrom, dateTo: value.dateTo, ...check }); continue; }
        let saved;
        if (value.kind === "vacation") {
          saved = await repository.insertVacationRequest({ employeeNumber: value.employeeNumber, locationId: context.locationId,
            dateFrom: value.dateFrom, dateTo: value.dateTo, note: value.note });
        } else {
          saved = await repository.insertTimeOffRequest({ employeeNumber: value.employeeNumber, locationId: context.locationId,
            originLocationId: context.originLocationId, reviewDepartmentId: context.departmentId, lendingId: context.lendingId,
            requestDate: value.dateFrom, dateFrom: value.dateFrom, dateTo: value.dateTo, allDay: value.allDay ? 1 : 0,
            startTime: value.allDay ? "00:00" : value.startTime, endTime: value.allDay ? "23:59" : value.endTime,
            note: value.note, approvalType: "local", trafficLight: check.trafficLight, checkReason: check.reason });
        }
        const id = Number(saved.rows[0]?.id);
        if (!Number.isSafeInteger(id) || id < 1) throw fail(502, "EMMA_ABSENCE_WRITE_UNCONFIRMED", "Die Antragsnummer konnte nicht bestätigt werden.");
        const entry = { id, employee_number: value.employeeNumber, location_id: context.locationId,
          origin_location_id: context.originLocationId, review_department_id: context.departmentId,
          lending_id: context.lendingId, date_from: value.dateFrom };
        await deps.decision(value.kind, id, "employee", "submit", actor.employeeNumber, "Über Emma beantragt", repository);
        await deps.notify(repository, entry, value.kind, "local", actor.employeeNumber);
        await deps.audit(repository, actor.employeeNumber, `${value.kind}.request.create`, `${value.kind}_request`, String(id),
          JSON.stringify({ via: "emma", subject: value.employeeNumber, trafficLight: check.trafficLight }));
        await deps.authorize(request, value, repository, context);
        const result = await load({ ...value, id }, repository);
        if (result.status !== "pending") throw fail(502, "EMMA_ABSENCE_WRITE_UNCONFIRMED", "Der Antrag ist nicht als offen bestätigt.");
        results.push({ id, status: "pending", check, request: { ...result, inputIndex: index } });
        }
        return { status: results.length ? "pending" : "blocked", requests: results.map(result => result.request),
          checks: results.map(result => result.check), blocked };
      }, { isolation: "serializable" });
    },
    async read(request, body) {
      if (!plain(body) || Object.keys(body).some(key => !["employeeNumber", "kind", "ids"].includes(key))
        || !Array.isArray(body.ids) || body.ids.length < 1 || body.ids.length > 12 || new Set(body.ids).size !== body.ids.length) {
        throw fail(400, "EMMA_ABSENCE_INPUT_INVALID", "Bitte die eindeutigen eigenen Antragsnummern angeben.");
      }
      const requests = [];
      for (const id of body.ids) {
        const value = input({ employeeNumber: body.employeeNumber, kind: body.kind, id }, deps.today(), true);
        await deps.authorize(request, value);
        const result = await load(value);
        await deps.authorize(request, { ...value, dateFrom: result.dateFrom }, repo, { locationId: result.locationId });
        requests.push(result);
      }
      return { requests };
    },
  };
}

function registerEmmaAbsenceRoutes(app, deps) {
  const service = createEmmaAbsenceRequests(deps);
  app.get(`${PREFIX}/capabilities`, async (request, response) => response.json(await service.capabilities(request)));
  for (const action of ["check", "submit", "read"]) app.post(`${PREFIX}/${action}`, async (request, response) => {
    deps.assertCsrf(request);
    response.status(action === "submit" ? 201 : 200).json(await service[action](request, request.body));
  });
}
module.exports = { PREFIX, authorizeEmmaAbsence, createEmmaAbsenceRequests, registerEmmaAbsenceRoutes, publicCheck, publicRequest };
