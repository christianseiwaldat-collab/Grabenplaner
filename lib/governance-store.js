"use strict";

const crypto = require("node:crypto");
const {
  createRetentionRuleVersion,
  previewRetentionCandidates,
  verifyRetentionRuleVersion,
} = require("./retention-policy");
const {
  completePrivacyRequest,
  createPrivacyRequest,
  decidePrivacyRequest,
  extendPrivacyRequestDeadline,
  setPrivacyRequestIdentity,
  verifyPrivacyRequest,
  withdrawPrivacyRequest,
} = require("./privacy-requests");
const {
  appendLeaveLedgerEntry,
  assessLeaveLimitation,
  createLeaveLedger,
  verifyLeaveLedger,
} = require("./leave-governance");
const {
  appendActualTimeEvent,
  createActualTimeLedger,
  createMonthlyTimeRecordStatement,
  finalizeMonthlyTimeRecordStatement,
  reviewMonthlyTimeRecordStatement,
  supersedeMonthlyTimeRecordStatement,
  verifyMonthlyTimeRecordStatement,
} = require("./time-record-statements");

const PRIVACY_TYPE_LABELS = Object.freeze({
  access: "Auskunft",
  rectification: "Berichtigung",
  erasure: "Löschung",
  restriction: "Einschränkung",
  portability: "Datenübertragbarkeit",
  objection: "Widerspruch",
});

function createGovernanceStore(options = {}) {
  const db = options.db;
  if (!db || typeof db.prepare !== "function") throw new TypeError("A SQLite database is required.");
  const protect = options.protectJson;
  const unprotect = options.parseProtectedJson;
  if (typeof protect !== "function" || typeof unprotect !== "function") {
    throw new TypeError("Protected JSON callbacks are required.");
  }
  const now = typeof options.now === "function" ? options.now : () => new Date();
  const uuid = typeof options.randomUUID === "function" ? options.randomUUID : () => crypto.randomUUID();

  function instant() {
    return now().toISOString();
  }

  function context(namespace, id, employeeNumber = "") {
    return {
      namespace,
      recordId: String(id || ""),
      field: namespace === "privacy-request" ? "state" : "payload",
      employeeNumber: String(employeeNumber || "system"),
    };
  }

  function dateOnly(value) {
    const parsed = new Date(value);
    if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid stored date.");
    return parsed.toISOString().slice(0, 10);
  }

  function normalizeInstant(value) {
    const raw = String(value || "").trim();
    if (!raw) return instant();
    const normalized = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(raw)
      ? `${raw.replace(" ", "T")}Z`
      : raw;
    const parsed = new Date(normalized);
    if (!Number.isFinite(parsed.getTime())) throw new Error("Invalid stored timestamp.");
    return parsed.toISOString();
  }

  function monthRange(month) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(String(month || ""))) {
      const error = new Error("Der Monat muss im Format YYYY-MM angegeben werden.");
      error.code = "TIME_RECORD_MONTH_INVALID";
      throw error;
    }
    const [year, number] = month.split("-").map(Number);
    const end = new Date(Date.UTC(year, number, 0, 12)).toISOString().slice(0, 10);
    return { start: `${month}-01`, end };
  }

  function governanceIntegrityError(message, code) {
    const error = new Error(message);
    error.code = code;
    return error;
  }

  function eventDetail(value, expectedKeys, code, label) {
    let detail;
    try {
      detail = JSON.parse(String(value || ""));
    } catch {
      throw governanceIntegrityError(`${label} enthaelt ungueltige Detaildaten.`, code);
    }
    if (!detail || typeof detail !== "object" || Array.isArray(detail)
      || Object.keys(detail).sort().join("\0") !== [...expectedKeys].sort().join("\0")) {
      throw governanceIntegrityError(`${label} enthaelt inkonsistente Detaildaten.`, code);
    }
    return detail;
  }

  function eventInstant(value, code, label) {
    try {
      return normalizeInstant(value);
    } catch {
      throw governanceIntegrityError(`${label} enthaelt einen ungueltigen Zeitpunkt.`, code);
    }
  }

  function eventIdMatches(value, prefix) {
    return new RegExp(
      `^${prefix}[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`,
      "i",
    ).test(String(value || ""));
  }

  function sameNumber(left, right) {
    return Number.isFinite(Number(left))
      && Number.isFinite(Number(right))
      && Math.abs(Number(left) - Number(right)) < 0.000001;
  }

  function retentionRuleRows() {
    return db.prepare(`
      SELECT * FROM retention_policy_versions
      ORDER BY category, version DESC, created_at DESC
    `).all().map((row) => {
      const rule = JSON.parse(row.configuration_json);
      if (!verifyRetentionRuleVersion(rule)) {
        const error = new Error(`Aufbewahrungsregel ${row.id} besitzt keinen gültigen Beleg.`);
        error.code = "RETENTION_RULE_RECEIPT_INVALID";
        throw error;
      }
      return rule;
    });
  }

  function insertRetentionRule(input, actor = "system") {
    const rule = createRetentionRuleVersion(input);
    const version = Number(rule.version);
    if (!Number.isSafeInteger(version) || version < 1) {
      const error = new Error("Die persistierte Regelversion muss eine positive ganze Zahl sein.");
      error.code = "RETENTION_VERSION_INVALID";
      throw error;
    }
    const durationDays = rule.retention.unit === "days"
      ? rule.retention.value
      : rule.retention.unit === "months"
        ? rule.retention.value * 30
        : rule.retention.value * 365;
    db.prepare(`
      INSERT INTO retention_policy_versions
        (id, category, version, status, valid_from, valid_to, duration_days, start_trigger,
         disposition, legal_basis, source_json, configuration_json, receipt_sha256, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      rule.id,
      rule.category,
      version,
      rule.status,
      rule.validFrom,
      rule.validTo,
      durationDays,
      rule.startTrigger,
      rule.disposition,
      "Fachlich und rechtlich vor Ausführung zu prüfen",
      JSON.stringify(rule.sources),
      JSON.stringify(rule),
      rule.contentSha256,
      String(actor || "system"),
    );
    return rule;
  }

  function seedRetentionRules(rules, actor = "system") {
    const existing = db.prepare("SELECT 1 FROM retention_policy_versions WHERE id = ? LIMIT 1");
    const inserted = [];
    for (const rule of rules) {
      if (existing.get(rule.id)) continue;
      inserted.push(insertRetentionRule(rule, actor));
    }
    return inserted;
  }

  function legalHolds() {
    return db.prepare(`
      SELECT id, category, subject_employee_number, reason, valid_from, valid_to, active
      FROM legal_holds ORDER BY created_at DESC, id
    `).all().map((row) => ({
      id: row.id,
      status: row.active ? "active" : "released",
      recordId: "",
      subjectId: row.subject_employee_number || "",
      category: row.category || "",
      validFrom: row.valid_from,
      validTo: row.valid_to || null,
      reasonCode: row.reason,
    }));
  }

  function previewRetention(records, asOf, actor = "system", additionalHolds = []) {
    const preview = previewRetentionCandidates({
      ruleVersions: retentionRuleRows(),
      records,
      legalHolds: [...legalHolds(), ...additionalHolds],
      asOf,
    });
    const id = `retention-preview:${uuid()}`;
    db.prepare(`
      INSERT INTO retention_preview_runs
        (id, as_of, result_json, result_sha256, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      id,
      preview.asOf,
      protect(preview, context("retention-preview", id)),
      preview.receiptSha256,
      String(actor || "system"),
      instant(),
    );
    return { id, ...preview };
  }

  function latestRetentionPreview() {
    const row = db.prepare(`
      SELECT * FROM retention_preview_runs ORDER BY created_at DESC, id DESC LIMIT 1
    `).get();
    if (!row) return null;
    const preview = unprotect(row.result_json, context("retention-preview", row.id));
    if (preview.receiptSha256 !== row.result_sha256) {
      const error = new Error("Die gespeicherte Aufbewahrungsvorschau ist nicht unverändert.");
      error.code = "RETENTION_PREVIEW_INTEGRITY_FAILED";
      throw error;
    }
    return {
      id: row.id,
      asOf: row.as_of,
      summary: preview.counts,
      createdAt: row.created_at,
      preview,
    };
  }

  function privacyRequestRow(id) {
    const row = db.prepare("SELECT * FROM privacy_requests WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    const state = unprotect(row.protected_payload, context("privacy-request", row.id, row.employee_number));
    if (!verifyPrivacyRequest(state)) {
      const error = new Error("Der gespeicherte Datenschutzantrag besitzt keinen gültigen Beleg.");
      error.code = "PRIVACY_REQUEST_INTEGRITY_FAILED";
      throw error;
    }
    assertPrivacyRequestEventLedger(state);
    return { row, state };
  }

  function privacyEventLedgerError(message) {
    const error = new Error(message);
    error.code = "PRIVACY_REQUEST_EVENT_LEDGER_INTEGRITY_FAILED";
    return error;
  }

  function assertPrivacyRequestEventLedger(state, { allowPrefix = false } = {}) {
    if (!verifyPrivacyRequest(state)) {
      throw privacyEventLedgerError("Der Datenschutzantrag besitzt keine gültige Ereignisbelegkette.");
    }
    const rows = db.prepare(`
      SELECT id, request_id, event_type, actor_employee_number, protected_payload,
             previous_receipt_sha256, receipt_sha256, created_at
      FROM privacy_request_events
      WHERE request_id = ?
      ORDER BY CAST(substr(id, instr(id, ':event:') + 7) AS INTEGER), id
    `).all(state.id);
    if (rows.length > state.events.length || (!allowPrefix && rows.length !== state.events.length)) {
      throw privacyEventLedgerError(
        "Der persistierte Datenschutzverlauf ist unvollständig oder enthält zusätzliche Ereignisse.",
      );
    }
    const rowsById = new Map(rows.map((row) => [row.id, row]));
    for (let index = 0; index < rows.length; index += 1) {
      const event = state.events[index];
      const eventId = `${state.id}:event:${event.sequence}`;
      const row = rowsById.get(eventId);
      if (!row) {
        throw privacyEventLedgerError("Der persistierte Datenschutzverlauf ist nicht lückenlos.");
      }
      const storedEvent = unprotect(
        row.protected_payload,
        context("privacy-request-event", eventId, state.subjectId),
      );
      const expectedActor = event.actor === "data_subject" ? state.subjectId : event.actor;
      if (row.request_id !== state.id
        || row.event_type !== event.type
        || row.actor_employee_number !== expectedActor
        || row.previous_receipt_sha256 !== event.previousReceiptSha256
        || row.receipt_sha256 !== event.receiptSha256
        || row.created_at !== event.at
        || JSON.stringify(storedEvent) !== JSON.stringify(event)) {
        throw privacyEventLedgerError(
          "Ein persistiertes Datenschutzereignis stimmt nicht mit der signierten Ereigniskette überein.",
        );
      }
    }
    return rows.length;
  }

  function privacySummary(state, row = {}) {
    return {
      id: state.id,
      employeeNumber: state.subjectId,
      type: state.type,
      typeLabel: PRIVACY_TYPE_LABELS[state.type] || state.type,
      status: state.status,
      scope: state.scope,
      receivedAt: state.receivedAt,
      dueAt: state.deadline.extendedTargetAt || state.deadline.initialTargetAt,
      initialDueAt: state.deadline.initialTargetAt,
      identityStatus: state.identity.status,
      assignedTo: row.assigned_to || "",
      updatedAt: row.updated_at || state.events.at(-1)?.at || state.receivedAt,
      receiptSha256: state.receiptSha256,
    };
  }

  function persistPrivacyRequest(state, actor = "system") {
    if (!verifyPrivacyRequest(state)) {
      const error = new Error("Der Datenschutzantrag kann ohne gültigen Beleg nicht gespeichert werden.");
      error.code = "PRIVACY_REQUEST_RECEIPT_INVALID";
      throw error;
    }
    const updatedAt = state.events.at(-1)?.at || instant();
    const payload = protect(state, context("privacy-request", state.id, state.subjectId));
    const insertEvent = db.prepare(`
      INSERT INTO privacy_request_events
        (id, request_id, event_type, actor_employee_number, protected_payload,
         previous_receipt_sha256, receipt_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
    db.exec("BEGIN IMMEDIATE");
    try {
      const existing = db.prepare("SELECT revision FROM privacy_requests WHERE id = ?").get(state.id);
      const revision = Number(existing?.revision || 0) + 1;
      const persistedEventCount = assertPrivacyRequestEventLedger(state, { allowPrefix: true });
      db.prepare(`
        INSERT INTO privacy_requests
          (id, employee_number, request_type, status, identity_status, received_at, due_at,
           extended_due_at, assigned_to, protected_payload, revision, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          status = excluded.status,
          identity_status = excluded.identity_status,
          due_at = excluded.due_at,
          extended_due_at = excluded.extended_due_at,
          protected_payload = excluded.protected_payload,
          revision = excluded.revision,
          updated_at = excluded.updated_at
      `).run(
        state.id,
        state.subjectId,
        state.type,
        state.status,
        state.identity.status,
        state.receivedAt,
        state.deadline.initialTargetAt,
        state.deadline.extendedTargetAt,
        "",
        payload,
        revision,
        updatedAt,
      );
      for (const event of state.events.slice(persistedEventCount)) {
        const eventId = `${state.id}:event:${event.sequence}`;
        insertEvent.run(
          eventId,
          state.id,
          event.type,
          event.actor === "data_subject" ? state.subjectId : event.actor,
          protect(event, context("privacy-request-event", eventId, state.subjectId)),
          event.previousReceiptSha256,
          event.receiptSha256,
          event.at,
        );
      }
      assertPrivacyRequestEventLedger(state);
      db.exec("COMMIT");
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
    return privacySummary(state, { updated_at: updatedAt });
  }

  function createRequest({ employeeNumber, type, scope, channel = "portal" }, actor = "data_subject") {
    const state = createPrivacyRequest({
      schemaVersion: 1,
      id: `privacy-request:${uuid()}`,
      type,
      subjectId: String(employeeNumber),
      scope,
      receivedAt: instant(),
      channel,
    });
    return { state, summary: persistPrivacyRequest(state, actor) };
  }

  function listPrivacyRequests(employeeNumber = "") {
    const rows = employeeNumber
      ? db.prepare("SELECT * FROM privacy_requests WHERE employee_number = ? ORDER BY received_at DESC").all(String(employeeNumber))
      : db.prepare("SELECT * FROM privacy_requests ORDER BY received_at DESC").all();
    return rows.map((row) => {
      const state = unprotect(row.protected_payload, context("privacy-request", row.id, row.employee_number));
      if (!verifyPrivacyRequest(state)) {
        const error = new Error(`Datenschutzantrag ${row.id} besitzt keinen gültigen Beleg.`);
        error.code = "PRIVACY_REQUEST_INTEGRITY_FAILED";
        throw error;
      }
      return privacySummary(state, row);
    });
  }

  function transitionPrivacyRequest(id, action, body, actor) {
    const current = privacyRequestRow(id);
    if (!current) return null;
    const at = instant();
    let next;
    if (action === "verify_identity") {
      next = setPrivacyRequestIdentity(current.state, {
        status: body.status === "insufficient" ? "insufficient" : "verified",
        assessedAt: at,
        assessedBy: actor,
        reasonCode: String(body.reasonCode || (body.status === "insufficient"
          ? "additional_evidence_needed"
          : "authenticated_portal_identity")),
      });
    } else if (action === "extend") {
      next = extendPrivacyRequestDeadline(current.state, {
        months: Number(body.months || 1),
        reasonCode: String(body.reasonCode || "complex_request"),
        reason: String(body.reason || "Zusätzliche fachliche Prüfung dokumentiert."),
        notifiedAt: at,
        actor,
      });
    } else if (action === "approve") {
      next = decidePrivacyRequest(current.state, {
        outcome: "approved",
        decidedAt: at,
        decidedBy: actor,
        approvedScope: current.state.scope,
        refusals: [],
        summary: String(body.summary || "Vollständig genehmigt und manuell geprüft."),
      });
    } else if (action === "reject") {
      const source = body.source;
      if (!source || typeof source !== "object") {
        const error = new Error("Eine Ablehnung benötigt eine dokumentierte offizielle Quelle.");
        error.code = "PRIVACY_REFUSAL_SOURCE_REQUIRED";
        throw error;
      }
      next = decidePrivacyRequest(current.state, {
        outcome: "rejected",
        decidedAt: at,
        decidedBy: actor,
        approvedScope: [],
        refusals: current.state.scope.map((scopeItem) => ({
          scopeItem,
          reasonCode: String(body.reasonCode || "documented_exception"),
          reason: String(body.reason || "Die Ausnahme wurde durch eine berechtigte Person geprüft."),
          sources: [source],
        })),
        summary: String(body.summary || "Vollständig abgelehnt und manuell dokumentiert."),
      });
    } else if (action === "complete") {
      next = completePrivacyRequest(current.state, {
        completedAt: at,
        completedBy: actor,
        reference: String(body.reference || `privacy-completion:${uuid()}`),
      });
    } else if (action === "withdraw") {
      next = withdrawPrivacyRequest(current.state, {
        at,
        actor,
        reasonCode: String(body.reasonCode || "withdrawn_by_subject"),
      });
    } else {
      const error = new Error("Die gewünschte Datenschutzaktion ist nicht unterstützt.");
      error.code = "PRIVACY_ACTION_INVALID";
      throw error;
    }
    return { state: next, summary: persistPrivacyRequest(next, actor) };
  }

  function vacationAccountRow(employeeNumber, year) {
    return db.prepare(`
      SELECT * FROM vacation_account_revisions
      WHERE employee_number = ? AND leave_year = ?
      ORDER BY revision DESC LIMIT 1
    `).get(String(employeeNumber), Number(year));
  }

  function vacationSummary(row, usage = {}) {
    const normalizedUsage = typeof usage === "number"
      ? { consumedDays: Number(usage || 0), plannedDays: Number(usage || 0) }
      : {
          consumedDays: Number(usage?.consumedDays || 0),
          plannedDays: Number(usage?.plannedDays ?? usage?.consumedDays ?? 0),
        };
    const ledger = unprotect(
      row.calculation_json,
      context("vacation-account", row.id, row.employee_number),
    );
    if (!verifyLeaveLedger(ledger)) {
      const error = new Error("Das Urlaubskonto besitzt keinen gültigen Beleg.");
      error.code = "VACATION_ACCOUNT_INTEGRITY_FAILED";
      throw error;
    }
    return {
      id: row.id,
      employeeNumber: row.employee_number,
      leaveYear: Number(row.leave_year),
      totalDays: Number(row.total_days),
      euMinimumDays: Number(row.eu_minimum_days),
      nationalAdditionalDays: Number(row.national_additional_days),
      consumedDays: normalizedUsage.consumedDays,
      plannedDays: normalizedUsage.plannedDays,
      remainingDays: Number(row.total_days) - normalizedUsage.plannedDays,
      expiryStatus: row.expiry_status,
      expiryCandidateOn: row.expiry_candidate_on || null,
      revision: Number(row.revision),
      receiptSha256: row.receipt_sha256,
      status: row.status,
    };
  }

  function ensureVacationAccount(input) {
    const employeeNumber = String(input.employeeNumber);
    const year = Number(input.year);
    const totalDays = Math.round(Number(input.totalDays || 0) * 100) / 100;
    const weeklyWorkdays = Math.max(1, Math.min(7, Number(input.weeklyWorkdays || 5)));
    const existing = vacationAccountRow(employeeNumber, year);
    if (existing && Number(existing.total_days) === totalDays
      && Number(existing.weekly_workdays) === weeklyWorkdays) {
      return vacationSummary(existing, {
        consumedDays: input.consumedDays,
        plannedDays: input.plannedDays,
      });
    }
    const leaveYearStart = `${year}-01-01`;
    const leaveYearEnd = `${year}-12-31`;
    const employmentStart = /^\d{4}-\d{2}-\d{2}$/.test(String(input.employmentStart || ""))
      ? String(input.employmentStart)
      : leaveYearStart;
    let ledger;
    if (existing) {
      ledger = unprotect(existing.calculation_json,
        context("vacation-account", existing.id, employeeNumber));
      if (!verifyLeaveLedger(ledger)) {
        const error = new Error("Die vorherige Urlaubskonto-Revision ist nicht unverändert.");
        error.code = "VACATION_ACCOUNT_INTEGRITY_FAILED";
        throw error;
      }
      ledger = appendLeaveLedgerEntry(ledger, {
        entryId: `leave-entry:${uuid()}`,
        kind: "entitlement_correction",
        effectiveDate: leaveYearStart,
        recordedAt: instant(),
        actorId: String(input.actor || "system"),
        supersedesEntryId: ledger.entries.at(-1)?.entryId || "",
        snapshot: {
          leaveYear: year,
          totalDays,
          previousTotalDays: Number(existing.total_days),
          weeklyWorkdays,
          source: "configured_entitlement",
          manualReview: true,
        },
      });
    } else {
      ledger = createLeaveLedger({
        ledgerId: `leave-ledger:${employeeNumber}:${year}`,
        employeeId: employeeNumber,
        createdAt: instant(),
        employmentStart,
        annualEntitlementDays: totalDays,
        workingDaysPerWeek: Math.round(weeklyWorkdays),
        leaveYearType: "calendar_year",
      });
      ledger = appendLeaveLedgerEntry(ledger, {
        entryId: `leave-entry:${uuid()}`,
        kind: "opening_import",
        effectiveDate: leaveYearStart,
        recordedAt: instant(),
        actorId: String(input.actor || "system"),
        supersedesEntryId: "",
        snapshot: {
          leaveYear: year,
          totalDays,
          weeklyWorkdays,
          source: "configured_entitlement",
          automaticGrant: false,
          manualReview: true,
        },
      });
    }
    const euMinimumDays = Math.min(totalDays, weeklyWorkdays * 4);
    const nationalAdditionalDays = Math.max(0, totalDays - euMinimumDays);
    const limitation = assessLeaveLimitation({
      tranche: {
        id: `leave-tranche:${employeeNumber}:${year}`,
        leaveYearStart,
        leaveYearEnd,
        grantedOn: leaveYearStart,
        euMinimumDays,
        nationalAdditionalDays,
        consumedEuMinimumDays: 0,
        consumedNationalAdditionalDays: 0,
        parentalLeaveExtensionDays: 0,
        status: "manual_review",
      },
      asOf: dateOnly(instant()),
      employerEvidence: {
        enablementProvided: false,
        formalInvitationProvided: false,
        timelyWarningProvided: false,
        evidenceIds: [],
      },
    });
    const revision = Number(existing?.revision || 0) + 1;
    const id = `vacation-account:${employeeNumber}:${year}:r${revision}`;
    db.prepare(`
      INSERT INTO vacation_account_revisions
        (id, employee_number, leave_year, revision, status, total_days, eu_minimum_days,
         national_additional_days, weekly_workdays, leave_year_start, leave_year_end,
         expiry_candidate_on, expiry_status, calculation_json, sources_json, receipt_sha256,
         supersedes_id, created_by, created_at)
      VALUES (?, ?, ?, ?, 'confirmed', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      employeeNumber,
      year,
      revision,
      totalDays,
      euMinimumDays,
      nationalAdditionalDays,
      weeklyWorkdays,
      leaveYearStart,
      leaveYearEnd,
      limitation.candidateOn,
      limitation.state,
      protect(ledger, context("vacation-account", id, employeeNumber)),
      JSON.stringify(ledger.sources),
      ledger.receiptSha256,
      existing?.id || null,
      String(input.actor || "system"),
      instant(),
    );
    const eventId = `vacation-account-event:${uuid()}`;
    db.prepare(`
      INSERT INTO vacation_account_events
        (id, employee_number, leave_year, account_revision_id, event_type, tranche_type,
         amount_days, effective_on, detail_json, receipt_sha256, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, 'unallocated', ?, ?, ?, ?, ?, ?)
    `).run(
      eventId,
      employeeNumber,
      year,
      id,
      existing ? "correction" : "opening",
      existing ? totalDays - Number(existing.total_days) : totalDays,
      leaveYearStart,
      JSON.stringify({ manualReview: true, source: "configured_entitlement" }),
      ledger.receiptSha256,
      String(input.actor || "system"),
      instant(),
    );
    return vacationSummary(db.prepare("SELECT * FROM vacation_account_revisions WHERE id = ?").get(id),
      {
        consumedDays: input.consumedDays,
        plannedDays: input.plannedDays,
      });
  }

  function timeStatementRow(id) {
    const row = db.prepare("SELECT * FROM time_record_statements WHERE id = ?").get(String(id || ""));
    if (!row) return null;
    const supersededBy = db.prepare(`
      SELECT id
      FROM time_record_statements
      WHERE supersedes_id = ?
      ORDER BY revision DESC, created_at DESC, id DESC
      LIMIT 1
    `).get(row.id);
    const statement = unprotect(
      row.snapshot_json,
      context("time-record-statement", row.id, row.employee_number),
    );
    if (!verifyMonthlyTimeRecordStatement(statement)) {
      const error = new Error("Der Monatsnachweis besitzt keinen gültigen Beleg.");
      error.code = "TIME_RECORD_STATEMENT_INTEGRITY_FAILED";
      throw error;
    }
    return {
      row,
      statement,
      archived: Boolean(supersededBy),
      supersededById: supersededBy?.id || "",
    };
  }

  function timeStatementSummary(row, statement, revisionState = {}) {
    const archived = Boolean(revisionState.archived);
    return {
      id: row.id,
      employeeNumber: row.employee_number,
      month: statement.month,
      revision: statement.revision,
      status: statement.status,
      completeness: statement.completeness,
      createdAt: statement.createdAt,
      finalizedAt: statement.finalization?.finalizedAt || "",
      actualMinutes: Number(statement.totals?.actualMinutes || 0),
      breakMinutes: Number(statement.totals?.breakMinutes || 0),
      issueCount: Array.isArray(statement.issues) ? statement.issues.length : 0,
      receiptSha256: statement.receiptSha256,
      archived,
      archiveStatus: archived ? "archived" : "current",
      supersededById: archived ? String(revisionState.supersededById || "") : "",
      downloadAvailable: statement.status === "finalized" && !archived,
    };
  }

  function verifyAuxiliaryEventIntegrity() {
    let verified = 0;
    const vacationCode = "VACATION_ACCOUNT_EVENT_INTEGRITY_FAILED";
    const timeCode = "TIME_RECORD_STATEMENT_EVENT_INTEGRITY_FAILED";

    const vacationRows = db.prepare(`
      SELECT * FROM vacation_account_revisions
      ORDER BY employee_number, leave_year, revision, id
    `).all();
    const vacationById = new Map(vacationRows.map((row) => [String(row.id), row]));
    const vacationEvents = db.prepare(`
      SELECT * FROM vacation_account_events
      ORDER BY account_revision_id, created_at, id
    `).all();
    const vacationEventsByRevision = new Map();
    for (const event of vacationEvents) {
      const key = String(event.account_revision_id);
      if (!vacationEventsByRevision.has(key)) vacationEventsByRevision.set(key, []);
      vacationEventsByRevision.get(key).push(event);
    }

    for (const row of vacationRows) {
      let ledger;
      try {
        ledger = unprotect(
          row.calculation_json,
          context("vacation-account", row.id, row.employee_number),
        );
      } catch {
        throw governanceIntegrityError(
          `Urlaubskonto-Revision ${row.id} konnte nicht sicher gelesen werden.`,
          vacationCode,
        );
      }
      const revision = Number(row.revision);
      const year = Number(row.leave_year);
      const expectedId = `vacation-account:${row.employee_number}:${year}:r${revision}`;
      const latestEntry = Array.isArray(ledger?.entries) ? ledger.entries.at(-1) : null;
      const snapshot = latestEntry?.snapshot;
      const previous = row.supersedes_id ? vacationById.get(String(row.supersedes_id)) : null;
      const expectedPrevious = revision > 1
        ? vacationRows.find((candidate) => (
          String(candidate.employee_number) === String(row.employee_number)
          && Number(candidate.leave_year) === year
          && Number(candidate.revision) === revision - 1
        ))
        : null;
      if (!verifyLeaveLedger(ledger)
        || String(row.id) !== expectedId
        || !Number.isSafeInteger(revision) || revision < 1
        || String(ledger.employeeId) !== String(row.employee_number)
        || String(ledger.ledgerId) !== `leave-ledger:${row.employee_number}:${year}`
        || Number(ledger.revision) !== revision + 1
        || !Array.isArray(ledger.entries) || ledger.entries.length !== revision
        || String(row.receipt_sha256) !== String(ledger.receiptSha256)
        || String(row.status) !== "confirmed"
        || !snapshot || Number(snapshot.leaveYear) !== year
        || !sameNumber(row.total_days, snapshot.totalDays)
        || !sameNumber(row.weekly_workdays, snapshot.weeklyWorkdays)
        || String(latestEntry.actorId) !== String(row.created_by || "system")
        || (revision === 1 && row.supersedes_id)
        || (revision > 1 && (
          !previous
          || !expectedPrevious
          || String(previous.id) !== String(expectedPrevious.id)
        ))) {
        throw governanceIntegrityError(
          `Urlaubskonto-Revision ${row.id} ist nicht konsistent belegt.`,
          vacationCode,
        );
      }

      const events = vacationEventsByRevision.get(String(row.id)) || [];
      const event = events[0];
      const expectedType = revision === 1 ? "opening" : "correction";
      const expectedAmount = revision === 1
        ? Number(row.total_days)
        : Number(row.total_days) - Number(previous.total_days);
      if (events.length !== 1
        || !eventIdMatches(event?.id, "vacation-account-event:")
        || String(event.employee_number) !== String(row.employee_number)
        || Number(event.leave_year) !== year
        || String(event.event_type) !== expectedType
        || String(event.tranche_type) !== "unallocated"
        || !sameNumber(event.amount_days, expectedAmount)
        || String(event.effective_on) !== String(row.leave_year_start)
        || String(event.receipt_sha256) !== String(row.receipt_sha256)
        || String(event.created_by) !== String(row.created_by)
        || eventInstant(event.created_at, vacationCode, `Urlaubskonto-Ereignis ${event?.id || ""}`)
          < eventInstant(row.created_at, vacationCode, `Urlaubskonto-Revision ${row.id}`)) {
        throw governanceIntegrityError(
          `Urlaubskonto-Ereignis für ${row.id} ist nicht konsistent belegt.`,
          vacationCode,
        );
      }
      const detail = eventDetail(
        event.detail_json,
        ["manualReview", "source"],
        vacationCode,
        `Urlaubskonto-Ereignis ${event.id}`,
      );
      if (detail.manualReview !== true || detail.source !== "configured_entitlement") {
        throw governanceIntegrityError(
          `Urlaubskonto-Ereignis ${event.id} enthält nicht belegte Detaildaten.`,
          vacationCode,
        );
      }
      verified += 1;
    }
    if (vacationEvents.length !== verified) {
      throw governanceIntegrityError(
        "Mindestens ein Urlaubskonto-Ereignis besitzt keine gültige Revision.",
        vacationCode,
      );
    }

    const statementRows = db.prepare(`
      SELECT * FROM time_record_statements
      ORDER BY employee_number, period_start, revision, id
    `).all();
    const statementById = new Map(statementRows.map((row) => [String(row.id), row]));
    const statementData = new Map();
    for (const row of statementRows) {
      let statement;
      try {
        statement = unprotect(
          row.snapshot_json,
          context("time-record-statement", row.id, row.employee_number),
        );
      } catch {
        throw governanceIntegrityError(
          `Arbeitszeitnachweis ${row.id} konnte nicht sicher gelesen werden.`,
          timeCode,
        );
      }
      let range;
      try {
        range = monthRange(statement?.month);
      } catch {
        throw governanceIntegrityError(
          `Arbeitszeitnachweis ${row.id} enthält einen ungültigen Zeitraum.`,
          timeCode,
        );
      }
      const revision = Number(row.revision);
      const expectedParent = revision > 1
        ? statementRows.find((candidate) => (
          String(candidate.employee_number) === String(row.employee_number)
          && String(candidate.period_start) === range.start
          && String(candidate.period_end) === range.end
          && Number(candidate.revision) === revision - 1
        ))
        : null;
      if (!verifyMonthlyTimeRecordStatement(statement)
        || String(row.id) !== `${statement.statementId}:r${statement.revision}`
        || String(row.employee_number) !== String(statement.employeeId)
        || revision !== Number(statement.revision)
        || String(row.status) !== String(statement.status)
        || String(row.source_sha256) !== String(statement.ledgerReceiptSha256)
        || String(row.receipt_sha256) !== String(statement.receiptSha256)
        || String(row.period_start) !== range.start
        || String(row.period_end) !== range.end
        || eventInstant(row.created_at, timeCode, `Arbeitszeitnachweis ${row.id}`)
          !== eventInstant(statement.createdAt, timeCode, `Arbeitszeitnachweis ${row.id}`)
        || (revision === 1 && (row.supersedes_id || statement.previousReceiptSha256))
        || (revision > 1 && (
          !expectedParent
          || String(row.supersedes_id) !== String(expectedParent.id)
          || String(statement.previousReceiptSha256) !== String(expectedParent.receipt_sha256)
        ))) {
        throw governanceIntegrityError(
          `Arbeitszeitnachweis ${row.id} ist nicht konsistent belegt.`,
          timeCode,
        );
      }
      statementData.set(String(row.id), statement);
    }

    const statementEvents = db.prepare(`
      SELECT * FROM time_record_statement_events
      ORDER BY statement_id, created_at, id
    `).all();
    const statementEventsByParent = new Map();
    for (const event of statementEvents) {
      const key = String(event.statement_id);
      if (!statementEventsByParent.has(key)) statementEventsByParent.set(key, []);
      statementEventsByParent.get(key).push(event);
    }
    let expectedStatementEventCount = 0;
    for (const row of statementRows) {
      const statement = statementData.get(String(row.id));
      const events = statementEventsByParent.get(String(row.id)) || [];
      const children = statementRows.filter((candidate) => (
        String(candidate.supersedes_id || "") === String(row.id)
      ));
      if (children.length > 1) {
        throw governanceIntegrityError(
          `Arbeitszeitnachweis ${row.id} besitzt mehrere konkurrierende Folgerevisionen.`,
          timeCode,
        );
      }
      const expectedPrimaryType = statement.status === "finalized" ? "finalized" : "created";
      const primaryEvents = events.filter(({ event_type }) => event_type === expectedPrimaryType);
      const supersedeEvents = events.filter(({ event_type }) => event_type === "superseded");
      const unexpectedEvents = events.filter(({ event_type }) => ![
        expectedPrimaryType,
        "superseded",
      ].includes(event_type));
      if (primaryEvents.length !== 1
        || supersedeEvents.length !== children.length
        || unexpectedEvents.length) {
        throw governanceIntegrityError(
          `Arbeitszeitnachweis ${row.id} besitzt einen unvollständigen Ereignisverlauf.`,
          timeCode,
        );
      }

      const primary = primaryEvents[0];
      const primaryDetail = eventDetail(
        primary.detail_json,
        ["statementId", "eventType", "actor", "at", "receiptSha256"],
        timeCode,
        `Arbeitszeitnachweis-Ereignis ${primary.id}`,
      );
      const primaryAt = eventInstant(
        primary.created_at,
        timeCode,
        `Arbeitszeitnachweis-Ereignis ${primary.id}`,
      );
      if (!eventIdMatches(primary.id, "time-statement-event:")
        || String(primary.actor_employee_number) !== String(row.created_by)
        || String(primary.receipt_sha256) !== String(row.receipt_sha256)
        || primaryDetail.statementId !== row.id
        || primaryDetail.eventType !== expectedPrimaryType
        || primaryDetail.actor !== row.created_by
        || primaryDetail.receiptSha256 !== row.receipt_sha256
        || eventInstant(primaryDetail.at, timeCode, `Arbeitszeitnachweis-Ereignis ${primary.id}`) !== primaryAt
        || primaryAt < eventInstant(row.created_at, timeCode, `Arbeitszeitnachweis ${row.id}`)) {
        throw governanceIntegrityError(
          `Arbeitszeitnachweis-Ereignis ${primary.id} ist nicht konsistent belegt.`,
          timeCode,
        );
      }
      expectedStatementEventCount += 1;

      if (children.length === 1) {
        const child = children[0];
        const superseded = supersedeEvents[0];
        const detail = eventDetail(
          superseded.detail_json,
          ["statementId", "eventType", "supersededByStatementId", "actor", "at", "receiptSha256"],
          timeCode,
          `Arbeitszeitnachweis-Ereignis ${superseded.id}`,
        );
        const supersededAt = eventInstant(
          superseded.created_at,
          timeCode,
          `Arbeitszeitnachweis-Ereignis ${superseded.id}`,
        );
        if (!eventIdMatches(superseded.id, "time-statement-event:")
          || String(superseded.actor_employee_number) !== String(child.created_by)
          || String(superseded.receipt_sha256) !== String(child.receipt_sha256)
          || detail.statementId !== row.id
          || detail.eventType !== "superseded"
          || detail.supersededByStatementId !== child.id
          || detail.actor !== child.created_by
          || detail.receiptSha256 !== child.receipt_sha256
          || eventInstant(detail.at, timeCode, `Arbeitszeitnachweis-Ereignis ${superseded.id}`) !== supersededAt
          || supersededAt < eventInstant(child.created_at, timeCode, `Arbeitszeitnachweis ${child.id}`)
          || !statementById.has(String(detail.supersededByStatementId))) {
          throw governanceIntegrityError(
            `Arbeitszeitnachweis-Ereignis ${superseded.id} ist nicht konsistent belegt.`,
            timeCode,
          );
        }
        expectedStatementEventCount += 1;
      }
      verified += events.length;
    }
    if (statementEvents.length !== expectedStatementEventCount) {
      throw governanceIntegrityError(
        "Mindestens ein Arbeitszeitnachweis-Ereignis besitzt keinen gültigen Nachweis.",
        timeCode,
      );
    }
    return verified;
  }

  function persistTimeStatement(statement, actor, supersedesId = null) {
    if (!verifyMonthlyTimeRecordStatement(statement)) {
      const error = new Error("Der Monatsnachweis kann ohne gültigen Beleg nicht gespeichert werden.");
      error.code = "TIME_RECORD_STATEMENT_RECEIPT_INVALID";
      throw error;
    }
    const range = monthRange(statement.month);
    const id = `${statement.statementId}:r${statement.revision}`;
    db.prepare(`
      INSERT INTO time_record_statements
        (id, employee_number, period_start, period_end, revision, status, source_sha256,
         snapshot_json, receipt_sha256, supersedes_id, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      statement.employeeId,
      range.start,
      range.end,
      statement.revision,
      statement.status,
      statement.ledgerReceiptSha256,
      protect(statement, context("time-record-statement", id, statement.employeeId)),
      statement.receiptSha256,
      supersedesId,
      String(actor || "system"),
      statement.createdAt,
    );
    const eventId = `time-statement-event:${uuid()}`;
    const eventType = statement.status === "finalized" ? "finalized" : "created";
    const event = {
      statementId: id,
      eventType,
      actor: String(actor || "system"),
      at: instant(),
      receiptSha256: statement.receiptSha256,
    };
    db.prepare(`
      INSERT INTO time_record_statement_events
        (id, statement_id, event_type, actor_employee_number, detail_json,
         receipt_sha256, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(eventId, id, eventType, event.actor, JSON.stringify(event),
      statement.receiptSha256, event.at);
    if (supersedesId) {
      const supersededEventId = `time-statement-event:${uuid()}`;
      const supersededEvent = {
        statementId: supersedesId,
        eventType: "superseded",
        supersededByStatementId: id,
        actor: String(actor || "system"),
        at: instant(),
        receiptSha256: statement.receiptSha256,
      };
      db.prepare(`
        INSERT INTO time_record_statement_events
          (id, statement_id, event_type, actor_employee_number, detail_json,
           receipt_sha256, created_at)
        VALUES (?, ?, 'superseded', ?, ?, ?, ?)
      `).run(
        supersededEventId,
        supersedesId,
        supersededEvent.actor,
        JSON.stringify(supersededEvent),
        statement.receiptSha256,
        supersededEvent.at,
      );
    }
    return { row: db.prepare("SELECT * FROM time_record_statements WHERE id = ?").get(id), statement };
  }

  function actualSource(value) {
    const source = String(value || "").toLowerCase();
    if (["portal", "mobile", "employee"].includes(source)) return "employee";
    if (["manager", "correction", "admin"].includes(source)) return "manager";
    if (["terminal", "time_terminal"].includes(source)) return "time_terminal";
    if (["import", "imported", "imported_actual"].includes(source)) return "imported_actual";
    return "system_actual";
  }

  function ledgerFromEntries(employeeNumber, month, entries) {
    let ledger = createActualTimeLedger({
      ledgerId: `actual-ledger:${employeeNumber}:${month}`,
      employeeId: employeeNumber,
      createdAt: entries.length ? normalizeInstant(entries[0].created_at || entries[0].entry_timestamp) : instant(),
    });
    for (const entry of entries) {
      ledger = appendActualTimeEvent(ledger, {
        eventId: `time-entry:${entry.id}`,
        type: entry.entry_type,
        workDate: entry.work_date,
        occurredAt: normalizeInstant(entry.entry_timestamp),
        recordedAt: normalizeInstant(entry.created_at || entry.entry_timestamp),
        source: actualSource(entry.source),
        actorId: String(entry.created_by || employeeNumber || "system"),
        note: String(entry.note || ""),
      });
    }
    return ledger;
  }

  function generateTimeStatement({ employeeNumber, month, entries, actor }) {
    monthRange(month);
    const ledger = ledgerFromEntries(employeeNumber, month, entries);
    const latestRow = db.prepare(`
      SELECT * FROM time_record_statements
      WHERE employee_number = ? AND period_start = ? AND period_end = ?
      ORDER BY revision DESC LIMIT 1
    `).get(employeeNumber, `${month}-01`, monthRange(month).end);
    if (!latestRow) {
      const statement = createMonthlyTimeRecordStatement({
        statementId: `time-statement:${employeeNumber}:${month}`,
        ledger,
        month,
        createdAt: instant(),
      });
      const saved = persistTimeStatement(statement, actor);
      return timeStatementSummary(saved.row, saved.statement);
    }
    const current = timeStatementRow(latestRow.id);
    if (current.statement.ledgerReceiptSha256 === ledger.receiptSha256) {
      return timeStatementSummary(current.row, current.statement, current);
    }
    const statement = supersedeMonthlyTimeRecordStatement(current.statement, {
      ledger,
      createdAt: instant(),
      actorId: String(actor || "system"),
      reason: "Ist-Zeitbuchungen oder nachvollziehbare Korrekturen wurden seit der letzten Revision geändert.",
    });
    const saved = persistTimeStatement(statement, actor, current.row.id);
    return timeStatementSummary(saved.row, saved.statement);
  }

  function transitionTimeStatement(id, action, body, actor) {
    const current = timeStatementRow(id);
    if (!current) return null;
    if (current.archived) {
      const error = new Error("Eine archivierte Monatsnachweis-Revision kann nicht erneut bearbeitet werden.");
      error.code = "TIME_RECORD_STATEMENT_ARCHIVED";
      throw error;
    }
    let statement;
    if (action === "review") {
      statement = reviewMonthlyTimeRecordStatement(current.statement, {
        decision: body.decision === "needs_correction" ? "needs_correction" : "approved",
        reviewedBy: actor,
        reviewedAt: instant(),
        note: String(body.note || ""),
      });
    } else if (action === "finalize") {
      statement = finalizeMonthlyTimeRecordStatement(current.statement, {
        finalizedBy: actor,
        finalizedAt: instant(),
      });
    } else {
      const error = new Error("Die gewünschte Nachweisaktion ist nicht unterstützt.");
      error.code = "TIME_RECORD_ACTION_INVALID";
      throw error;
    }
    const saved = persistTimeStatement(statement, actor, current.row.id);
    return timeStatementSummary(saved.row, saved.statement);
  }

  function listTimeStatements({
    month,
    employeeNumber = "",
    finalizedOnly = false,
    includeArchived = false,
  }) {
    const range = monthRange(month);
    const where = ["s.period_start = ?", "s.period_end = ?"];
    const values = [range.start, range.end];
    if (employeeNumber) {
      where.push("s.employee_number = ?");
      values.push(String(employeeNumber));
    }
    if (finalizedOnly) where.push("s.status = 'finalized'");
    if (!includeArchived) {
      where.push(`
        NOT EXISTS (
          SELECT 1 FROM time_record_statements newer
          WHERE newer.supersedes_id = s.id
        )
      `);
    }
    const rows = db.prepare(`
      SELECT s.*,
             (
               SELECT newer.id FROM time_record_statements newer
               WHERE newer.supersedes_id = s.id
               ORDER BY newer.revision DESC, newer.created_at DESC, newer.id DESC
               LIMIT 1
             ) AS superseded_by_id
      FROM time_record_statements s
      WHERE ${where.join(" AND ")}
      ORDER BY s.employee_number, s.revision DESC, s.created_at DESC
    `).all(...values);
    return rows.map((row) => {
      const statement = unprotect(
        row.snapshot_json,
        context("time-record-statement", row.id, row.employee_number),
      );
      if (!verifyMonthlyTimeRecordStatement(statement)) {
        const error = new Error(`Monatsnachweis ${row.id} besitzt keinen gültigen Beleg.`);
        error.code = "TIME_RECORD_STATEMENT_INTEGRITY_FAILED";
        throw error;
      }
      return timeStatementSummary(row, statement, {
        archived: Boolean(row.superseded_by_id),
        supersededById: row.superseded_by_id || "",
      });
    });
  }

  return {
    assertPrivacyRequestEventLedger,
    createRequest,
    ensureVacationAccount,
    generateTimeStatement,
    insertRetentionRule,
    latestRetentionPreview,
    legalHolds,
    listPrivacyRequests,
    listTimeStatements,
    persistPrivacyRequest,
    previewRetention,
    privacyRequestRow,
    privacySummary,
    retentionRuleRows,
    seedRetentionRules,
    timeStatementRow,
    transitionPrivacyRequest,
    transitionTimeStatement,
    vacationAccountRow,
    vacationSummary,
    verifyAuxiliaryEventIntegrity,
  };
}

module.exports = {
  PRIVACY_TYPE_LABELS,
  createGovernanceStore,
};
