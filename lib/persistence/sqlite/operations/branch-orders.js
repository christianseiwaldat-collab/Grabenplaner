"use strict";

const crypto = require("node:crypto");
const {
  branchOrderPdfSha256,
  buildBranchOrderPdfFilename,
  renderBranchOrderPdf,
} = require("../../../branch-order-pdf");

const BRANCH_ORDER_UNITS = Object.freeze([
  "Stück",
  "Packung",
  "Karton",
  "Rolle",
  "Satz",
  "Paar",
  "Block",
  "Flasche",
  "Meter",
  "Einheit",
]);

const DEFAULT_SUBJECT_TEMPLATE = "Filialbestellung {{locationName}} · KW {{calendarWeek}}";
const DEFAULT_BODY_TEMPLATE = [
  "Guten Tag,",
  "",
  "für {{locationName}} wurde für KW {{calendarWeek}} folgende Bestellung erfasst:",
  "",
  "{{items}}",
  "",
  "Ausgewählt für: {{employeeName}} (MA-Nr. {{employeeNumber}})",
  "Erfasst am: {{submittedAt}}",
].join("\n");

const TEMPLATE_KEYS = new Set([
  "locationName",
  "calendarWeek",
  "weekStart",
  "employeeName",
  "employeeNumber",
  "submittedAt",
  "items",
]);

const DEFAULT_BRANCH_ORDER_GROUPS = Object.freeze([
  Object.freeze({
    title: "Lager",
    hint: "Lager- und Versandmaterial",
    recipient: Object.freeze({ email: "lager@lamprechter.com" }),
    items: Object.freeze([
      ["Batteriesammelbehälter", "Stück"],
      ["Bildertaschen für Sofortdruck", "Packung"],
      ["Briefkuverts / Kuverts", "Packung"],
      ["Fotodrucker: Mediaset DS40", "Packung"],
      ["Fotodrucker: Mediaset DS80", "Packung"],
      ["Fotodrucker: Mediaset DS620", "Packung"],
      ["Kartonagen für Versand", "Karton"],
      ["Kassarollen", "Rolle"],
      ["Thermorollen für Bondrucker / Kassa", "Rolle"],
      ["Klebeband braun", "Rolle"],
      ["Klebeband transparent", "Rolle"],
      ["Papier 80 g A4 für interne Drucker", "Packung"],
      ["Papier 80 g A3 für interne Drucker", "Packung"],
      ["Plotterpapier", "Rolle"],
      ["Plottertinten Canon", "Stück"],
      ["Plotter-Wartungsbehälter", "Stück"],
      ["Plotter: Sonstiges", "Einheit"],
      ["Rollen für Preisauszeichner", "Rolle"],
      ["Verpackungsmaterial", "Packung"],
      ["Versandtaschen für analoge Filme", "Packung"],
      ["Versandtaschen gelb, gepolstert", "Packung"],
    ]),
  }),
  Object.freeze({
    title: "Marketing",
    hint: "Marketingmaterial und Kundenunterlagen",
    recipient: Object.freeze({ email: "team-marketing@lamprechter.com" }),
    items: Object.freeze([
      ["Bilderbonuskarten", "Packung"],
      ["Bilderwelten Kataloge", "Packung"],
      ["Dienstleistungsflyer", "Packung"],
      ["Flyer Fotobook", "Packung"],
      ["Flyer Kurse", "Packung"],
      ["Foto Connection Kataloge", "Packung"],
      ["Geschenk-Gutscheine € 10", "Block"],
      ["Geschenk-Gutscheine € 30", "Block"],
      ["Geschenk-Gutscheine € 50", "Block"],
      ["Geschenk-Gutscheine € 100", "Block"],
      ["Gutscheine: Gratis analoge Entwicklung", "Block"],
      ["Gutscheine: HD-Premium", "Block"],
      ["Gutscheine: Sensorreinigung", "Block"],
      ["Kundenanlageformular", "Block"],
      ["Kundenbestellblöcke", "Block"],
      ["Notizblöcke", "Block"],
      ["Passbildeinleger", "Packung"],
      ["Passbildhüllen", "Packung"],
      ["Passbildkleber", "Packung"],
      ["Visitenkarten", "Packung"],
      ["Warenbegleitformulare", "Block"],
    ]),
  }),
  Object.freeze({
    title: "Sonstiges",
    hint: "E-Mail-Ziel vor der ersten Bestellung in den Filialbestell-Einstellungen zuordnen.",
    recipient: null,
    items: Object.freeze([
      ["Büromaterial: Tixo, Heftklammern, Gummibänder, …", "Einheit"],
      ["Formulare (Wissensdatenbank → Formulare)", "Einheit"],
    ]),
  }),
]);

class BranchOrderError extends Error {
  constructor(message, code = "BRANCH_ORDER_INVALID", status = 400) {
    super(message);
    this.name = "BranchOrderError";
    this.code = code;
    this.status = status;
  }
}

function branchOrderError(message, code, status) {
  return new BranchOrderError(message, code, status);
}

function assertDatabase(database) {
  if (!database || typeof database.exec !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Eine SQLite-Operationsdatenbank wird benötigt.");
  }
  return database;
}

function ensureSqliteBranchOrdersSchema(database) {
  const db = assertDatabase(database);
  db.exec(`
    CREATE TABLE IF NOT EXISTS branch_order_location_settings (
      location_id TEXT PRIMARY KEY REFERENCES locations(id) ON DELETE CASCADE,
      initialized_at TEXT NOT NULL,
      initialized_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS branch_order_recipients (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      email TEXT NOT NULL COLLATE NOCASE,
      reply_to_email TEXT NOT NULL DEFAULT '',
      subject_template TEXT NOT NULL,
      body_template TEXT NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      UNIQUE(location_id, email)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_recipients_location
      ON branch_order_recipients(location_id, email);

    CREATE TABLE IF NOT EXISTS branch_order_groups (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      recipient_id TEXT REFERENCES branch_order_recipients(id) ON DELETE SET NULL,
      title TEXT NOT NULL,
      hint TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_groups_location
      ON branch_order_groups(location_id, active, sort_order, id);

    CREATE TABLE IF NOT EXISTS branch_order_items (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES branch_order_groups(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      unit TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_items_group
      ON branch_order_items(group_id, active, sort_order, id);

    CREATE TABLE IF NOT EXISTS branch_orders (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE RESTRICT,
      week_start TEXT NOT NULL,
      calendar_week INTEGER NOT NULL CHECK (calendar_week BETWEEN 1 AND 53),
      selected_employee_number TEXT NOT NULL,
      selected_employee_name TEXT NOT NULL,
      submitted_by_account_id TEXT NOT NULL,
      submitted_by_login TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'partial', 'failed')),
      submitted_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      pdf_filename TEXT NOT NULL DEFAULT '',
      pdf_sha256 TEXT NOT NULL DEFAULT '',
      pdf_content BLOB,
      pdf_generated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_branch_orders_location_submitted
      ON branch_orders(location_id, submitted_at DESC, id DESC);

    CREATE TABLE IF NOT EXISTS branch_order_lines (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES branch_orders(id) ON DELETE CASCADE,
      recipient_email TEXT NOT NULL,
      group_title TEXT NOT NULL,
      item_title TEXT NOT NULL,
      quantity REAL NOT NULL CHECK (quantity > 0),
      unit TEXT NOT NULL,
      note TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_lines_order
      ON branch_order_lines(order_id, sort_order, id);

    CREATE TABLE IF NOT EXISTS branch_order_deliveries (
      id TEXT PRIMARY KEY,
      order_id TEXT NOT NULL REFERENCES branch_orders(id) ON DELETE CASCADE,
      sender_email TEXT NOT NULL DEFAULT '',
      recipient_email TEXT NOT NULL,
      reply_to_email TEXT NOT NULL,
      subject_snapshot TEXT NOT NULL,
      body_snapshot TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
      failure_code TEXT NOT NULL DEFAULT '',
      attempted_at TEXT,
      sent_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_deliveries_order
      ON branch_order_deliveries(order_id, status, id);

    CREATE TABLE IF NOT EXISTS branch_order_drafts (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      owner_account_id TEXT NOT NULL,
      owner_kind TEXT NOT NULL CHECK (owner_kind IN ('organization', 'employee')),
      selected_employee_number TEXT NOT NULL,
      selected_employee_name TEXT NOT NULL,
      week_start_at_save TEXT NOT NULL,
      configuration_updated_at TEXT NOT NULL DEFAULT '',
      revision INTEGER NOT NULL CHECK (revision >= 1),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by_login TEXT NOT NULL,
      UNIQUE(location_id, owner_account_id, selected_employee_number)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_drafts_owner
      ON branch_order_drafts(location_id, owner_account_id, selected_employee_number);

    CREATE TABLE IF NOT EXISTS branch_order_draft_lines (
      draft_id TEXT NOT NULL REFERENCES branch_order_drafts(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL,
      item_title_snapshot TEXT NOT NULL,
      unit_snapshot TEXT NOT NULL,
      quantity INTEGER NOT NULL
        CHECK (quantity BETWEEN 1 AND 100000 AND quantity = CAST(quantity AS INTEGER)),
      note TEXT NOT NULL DEFAULT '',
      sort_order INTEGER NOT NULL,
      PRIMARY KEY(draft_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_draft_lines_draft
      ON branch_order_draft_lines(draft_id, sort_order, item_id);
  `);
  const deliveryColumns = new Set(
    db.prepare("PRAGMA table_info(branch_order_deliveries)").all()
      .map((column) => String(column.name)),
  );
  if (!deliveryColumns.has("sender_email")) {
    db.exec("ALTER TABLE branch_order_deliveries ADD COLUMN sender_email TEXT NOT NULL DEFAULT ''");
  }
  const orderColumns = new Set(
    db.prepare("PRAGMA table_info(branch_orders)").all()
      .map((column) => String(column.name)),
  );
  if (!orderColumns.has("pdf_filename")) {
    db.exec("ALTER TABLE branch_orders ADD COLUMN pdf_filename TEXT NOT NULL DEFAULT ''");
  }
  if (!orderColumns.has("pdf_sha256")) {
    db.exec("ALTER TABLE branch_orders ADD COLUMN pdf_sha256 TEXT NOT NULL DEFAULT ''");
  }
  if (!orderColumns.has("pdf_content")) {
    db.exec("ALTER TABLE branch_orders ADD COLUMN pdf_content BLOB");
  }
  if (!orderColumns.has("pdf_generated_at")) {
    db.exec("ALTER TABLE branch_orders ADD COLUMN pdf_generated_at TEXT");
  }
}

function textValue(value, { label, minimum = 0, maximum, preserveLines = false } = {}) {
  const raw = String(value ?? "").replace(/\r\n?/g, "\n");
  const normalized = preserveLines
    ? raw.trim()
    : raw.replace(/\s+/g, " ").trim();
  if (normalized.includes("\0") || normalized.length < minimum || (maximum && normalized.length > maximum)) {
    throw branchOrderError(
      `${label || "Der Wert"} ist ungültig.`,
      "BRANCH_ORDER_CONFIGURATION_INVALID",
    );
  }
  return normalized;
}

function validEmail(value) {
  const email = String(value || "").trim().toLowerCase();
  return email.length <= 320
    && !/[\r\n]/.test(email)
    && /^[^@\s<>]+@[^@\s<>]+\.[^@\s<>]+$/.test(email);
}

function normalizedEmail(value, label) {
  const email = String(value || "").trim().toLowerCase();
  if (!validEmail(email)) {
    throw branchOrderError(`${label || "Die E-Mail-Adresse"} ist ungültig.`, "BRANCH_ORDER_EMAIL_INVALID");
  }
  return email;
}

function normalizedTemplate(value, { subject = false } = {}) {
  const template = textValue(value, {
    label: subject ? "Der E-Mail-Betreff" : "Der E-Mail-Text",
    minimum: 1,
    maximum: subject ? 180 : 8000,
    preserveLines: !subject,
  });
  if (subject && /[\r\n]/.test(template)) {
    throw branchOrderError("Der E-Mail-Betreff darf keinen Zeilenumbruch enthalten.", "BRANCH_ORDER_TEMPLATE_INVALID");
  }
  for (const match of template.matchAll(/\{\{\s*([^{}]+?)\s*\}\}/g)) {
    if (!TEMPLATE_KEYS.has(match[1])) {
      throw branchOrderError(
        `Der Platzhalter {{${match[1]}}} ist nicht verfügbar.`,
        "BRANCH_ORDER_TEMPLATE_INVALID",
      );
    }
  }
  return template;
}

function normalizedQuantity(value) {
  const quantity = Number(value);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > 100000) {
    throw branchOrderError("Die Bestellmenge muss eine ganze Zahl zwischen 1 und 100000 sein.", "BRANCH_ORDER_QUANTITY_INVALID");
  }
  return quantity;
}

function normalizedUnit(value) {
  const unit = textValue(value, { label: "Die Einheit", minimum: 1, maximum: 40 });
  if (!BRANCH_ORDER_UNITS.includes(unit)) {
    throw branchOrderError("Die gewählte Einheit ist nicht freigegeben.", "BRANCH_ORDER_UNIT_INVALID");
  }
  return unit;
}

function safeClientReference(value, fallback) {
  const reference = String(value || "").trim();
  if (!reference || reference.length > 160 || /[\0\r\n]/.test(reference)) return fallback;
  return reference;
}

function renderTemplate(template, values) {
  return String(template || "").replace(/\{\{\s*([^{}]+?)\s*\}\}/g, (_match, key) => (
    Object.hasOwn(values, key) ? String(values[key] ?? "") : ""
  ));
}

function numberText(value) {
  return new Intl.NumberFormat("de-AT", { maximumFractionDigits: 0 }).format(Number(value));
}

function orderMailFooter(replyToEmail) {
  return [
    "",
    "Hinweis: Antworten auf diese automatisch versendete Nachricht sind nicht möglich.",
    `Bitte antworten Sie an ${replyToEmail}.`,
  ].join("\n");
}

function createSqliteBranchOrderOperations(database) {
  const db = assertDatabase(database);

  function transaction(work) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      db.exec("COMMIT");
      return result;
    } catch (error) {
      try { db.exec("ROLLBACK"); } catch {}
      throw error;
    }
  }

  function hasLocationSettings(locationId) {
    return Boolean(db.prepare(`
      SELECT 1
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId)));
  }

  function ensureLocationConfiguration(locationId, actor = "system") {
    const normalizedLocationId = String(locationId || "").trim();
    if (!normalizedLocationId) throw branchOrderError("Die Filiale fehlt.", "BRANCH_ORDER_LOCATION_REQUIRED");
    if (hasLocationSettings(normalizedLocationId)) return false;
    return transaction(() => {
      if (hasLocationSettings(normalizedLocationId)) return false;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO branch_order_location_settings
          (location_id, initialized_at, initialized_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(normalizedLocationId, now, actor, now, actor);

      const recipientIds = new Map();
      for (const definition of DEFAULT_BRANCH_ORDER_GROUPS) {
        if (!definition.recipient || recipientIds.has(definition.recipient.email)) continue;
        const id = crypto.randomUUID();
        recipientIds.set(definition.recipient.email, id);
        db.prepare(`
          INSERT INTO branch_order_recipients
            (id, location_id, email, reply_to_email, subject_template, body_template,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          id,
          normalizedLocationId,
          definition.recipient.email,
          definition.recipient.email,
          DEFAULT_SUBJECT_TEMPLATE,
          DEFAULT_BODY_TEMPLATE,
          now,
          actor,
          now,
          actor,
        );
      }
      for (const [groupIndex, definition] of DEFAULT_BRANCH_ORDER_GROUPS.entries()) {
        const groupId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO branch_order_groups
            (id, location_id, recipient_id, title, hint, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          groupId,
          normalizedLocationId,
          definition.recipient ? recipientIds.get(definition.recipient.email) : null,
          definition.title,
          definition.hint,
          groupIndex + 1,
          now,
          actor,
          now,
          actor,
        );
        for (const [itemIndex, [title, unit]] of definition.items.entries()) {
          db.prepare(`
            INSERT INTO branch_order_items
              (id, group_id, title, unit, active, sort_order,
               created_at, created_by, updated_at, updated_by)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          `).run(
            crypto.randomUUID(),
            groupId,
            title,
            unit,
            itemIndex + 1,
            now,
            actor,
            now,
            actor,
          );
        }
      }
      return true;
    });
  }

  function ensureActiveBranchAccountBasePermissions() {
    const accountTable = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'portal_organization_accounts'
    `).get();
    if (!accountTable) return 0;
    const result = db.prepare(`
      INSERT OR IGNORE INTO portal_organization_account_permissions
        (account_id, permission, granted_by, updated_at)
      SELECT account.id, required.permission, 'system:branch-account-base', CURRENT_TIMESTAMP
      FROM portal_organization_accounts account
      CROSS JOIN (
        SELECT 'loans:overview:read' AS permission
        UNION ALL SELECT 'schedule:location:view'
      ) required
      WHERE account.account_type = 'branch' AND account.active = 1
    `).run();
    return Number(result.changes || 0);
  }

  function locationRow(locationId) {
    return db.prepare(`
      SELECT id, name
      FROM locations
      WHERE id = ? AND active = 1
    `).get(String(locationId));
  }

  function activeEmployeeRow(locationId, employeeNumber) {
    return db.prepare(`
      SELECT personnel_number AS employeeNumber, full_name AS fullName
      FROM employees
      WHERE personnel_number = ? AND home_location_id = ? AND active = 1
    `).get(String(employeeNumber), String(locationId));
  }

  function configurationUpdatedAt(locationId) {
    ensureLocationConfiguration(locationId);
    return String(db.prepare(`
      SELECT updated_at AS updatedAt
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId))?.updatedAt || "");
  }

  function settingsSnapshot(locationId) {
    ensureLocationConfiguration(locationId);
    const recipients = db.prepare(`
      SELECT id, email, reply_to_email AS replyToEmail,
             subject_template AS subjectTemplate, body_template AS bodyTemplate
      FROM branch_order_recipients
      WHERE location_id = ?
      ORDER BY email COLLATE NOCASE, id
    `).all(String(locationId)).map((row) => ({
      id: row.id,
      email: row.email,
      replyToEmail: validEmail(row.replyToEmail) ? row.replyToEmail : row.email,
      subjectTemplate: row.subjectTemplate,
      bodyTemplate: row.bodyTemplate,
    }));
    const groups = db.prepare(`
      SELECT id, recipient_id AS recipientId, title, hint, active, sort_order AS sortOrder
      FROM branch_order_groups
      WHERE location_id = ?
      ORDER BY sort_order, title COLLATE NOCASE, id
    `).all(String(locationId)).map((row) => ({
      id: row.id,
      recipientId: row.recipientId || "",
      title: row.title,
      hint: row.hint,
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
      items: [],
    }));
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const items = db.prepare(`
      SELECT item.id, item.group_id AS groupId, item.title, item.unit,
             item.active, item.sort_order AS sortOrder
      FROM branch_order_items item
      JOIN branch_order_groups grouping ON grouping.id = item.group_id
      WHERE grouping.location_id = ?
      ORDER BY grouping.sort_order, item.sort_order, item.title COLLATE NOCASE, item.id
    `).all(String(locationId));
    for (const item of items) {
      groupsById.get(item.groupId)?.items.push({
        id: item.id,
        title: item.title,
        unit: item.unit,
        active: Boolean(item.active),
        sortOrder: Number(item.sortOrder),
      });
    }
    return {
      locationId: String(locationId),
      recipients,
      groups,
      units: [...BRANCH_ORDER_UNITS],
      templateDefaults: {
        subjectTemplate: DEFAULT_SUBJECT_TEMPLATE,
        bodyTemplate: DEFAULT_BODY_TEMPLATE,
      },
    };
  }

  function catalogSnapshot(locationId) {
    const location = locationRow(locationId);
    if (!location) throw branchOrderError("Die Filiale ist nicht aktiv.", "BRANCH_ORDER_LOCATION_INVALID", 404);
    const configuration = settingsSnapshot(locationId);
    const recipientById = new Map(configuration.recipients.map((recipient) => [recipient.id, recipient]));
    const groups = configuration.groups
      .filter((group) => group.active)
      .map((group) => ({
        id: group.id,
        title: group.title,
        hint: group.hint,
        deliveryReady: Boolean(
          group.recipientId
          && validEmail(recipientById.get(group.recipientId)?.email)
          && validEmail(recipientById.get(group.recipientId)?.replyToEmail),
        ),
        items: group.items
          .filter((item) => item.active)
          .map((item) => ({ id: item.id, title: item.title, unit: item.unit })),
      }));
    const employees = db.prepare(`
      SELECT personnel_number AS employeeNumber, full_name AS fullName
      FROM employees
      WHERE active = 1 AND home_location_id = ?
      ORDER BY full_name COLLATE NOCASE, personnel_number COLLATE NOCASE
    `).all(String(locationId)).map((row) => ({
      employeeNumber: String(row.employeeNumber),
      fullName: String(row.fullName),
    }));
    return {
      location: { id: String(location.id), name: String(location.name) },
      groups,
      employees,
      configurationUpdatedAt: configurationUpdatedAt(locationId),
    };
  }

  function normalizedDraftScope(input = {}) {
    const ownerKind = String(input.ownerKind || "").trim();
    if (!new Set(["organization", "employee"]).has(ownerKind)) {
      throw branchOrderError("Der Entwurfszugang ist ungültig.", "BRANCH_ORDER_DRAFT_SCOPE_INVALID", 403);
    }
    return {
      ownerKind,
      ownerAccountId: textValue(input.ownerAccountId, {
        label: "Der Entwurfszugang", minimum: 1, maximum: 160,
      }),
      updatedByLogin: textValue(input.updatedByLogin || input.ownerAccountId, {
        label: "Der Entwurfszugang", minimum: 1, maximum: 160,
      }),
    };
  }

  function normalizedDraftRevision(value) {
    const revision = Number(value);
    if (!Number.isSafeInteger(revision) || revision < 0) {
      throw branchOrderError("Die Entwurfsrevision ist ungültig.", "BRANCH_ORDER_DRAFT_REVISION_INVALID");
    }
    return revision;
  }

  function activeDraftItems(locationId) {
    return new Map(db.prepare(`
      SELECT item.id, item.title, item.unit
      FROM branch_order_items item
      JOIN branch_order_groups grouping ON grouping.id = item.group_id
      WHERE grouping.location_id = ? AND grouping.active = 1 AND item.active = 1
    `).all(String(locationId)).map((item) => [String(item.id), {
      id: String(item.id),
      title: String(item.title),
      unit: String(item.unit),
    }]));
  }

  function preparedDraft(locationId, input = {}) {
    const location = locationRow(locationId);
    if (!location) throw branchOrderError("Die Filiale ist nicht aktiv.", "BRANCH_ORDER_LOCATION_INVALID", 404);
    ensureLocationConfiguration(locationId);
    const scope = normalizedDraftScope(input);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    const employee = activeEmployeeRow(locationId, employeeNumber);
    if (!employee) {
      throw branchOrderError(
        "Die ausgewählte Person ist für diese Filiale nicht aktiv.",
        "BRANCH_ORDER_EMPLOYEE_SCOPE_DENIED",
        403,
      );
    }
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 200) {
      throw branchOrderError("Bitte mindestens eine Bestellposition mit Menge auswählen.", "BRANCH_ORDER_ITEMS_REQUIRED");
    }
    const availableItems = activeDraftItems(locationId);
    const selectedIds = new Set();
    const lines = input.items.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw branchOrderError("Eine Bestellposition ist ungültig.", "BRANCH_ORDER_ITEMS_INVALID");
      }
      const itemId = textValue(entry.itemId, { label: "Die Bestellposition", minimum: 1, maximum: 160 });
      if (selectedIds.has(itemId)) {
        throw branchOrderError("Eine Bestellposition darf nur einmal gespeichert werden.", "BRANCH_ORDER_ITEMS_INVALID");
      }
      selectedIds.add(itemId);
      const item = availableItems.get(itemId);
      if (!item) {
        throw branchOrderError(
          "Eine Bestellposition ist nicht mehr verfügbar. Bitte den Entwurf aktualisieren.",
          "BRANCH_ORDER_ITEM_NOT_FOUND",
          409,
        );
      }
      return {
        itemId,
        itemTitle: item.title,
        unit: item.unit,
        quantity: normalizedQuantity(entry.quantity),
        note: textValue(entry.note, { label: "Die Bemerkung", maximum: 500 }),
        sortOrder: index + 1,
      };
    });
    return {
      ...scope,
      locationId: String(location.id),
      employee: { employeeNumber: String(employee.employeeNumber), fullName: String(employee.fullName) },
      weekStartAtSave: textValue(input.weekStartAtSave, {
        label: "Die Kalenderwoche", minimum: 10, maximum: 10,
      }),
      configurationUpdatedAt: configurationUpdatedAt(locationId),
      expectedRevision: normalizedDraftRevision(input.expectedRevision),
      lines,
    };
  }

  function draftSnapshot(locationId, input = {}) {
    const scope = normalizedDraftScope(input);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    if (!activeEmployeeRow(locationId, employeeNumber)) return null;
    const row = db.prepare(`
      SELECT id, location_id AS locationId, owner_kind AS ownerKind,
             selected_employee_number AS selectedEmployeeNumber,
             selected_employee_name AS selectedEmployeeName,
             week_start_at_save AS weekStartAtSave,
             configuration_updated_at AS configurationUpdatedAt,
             revision, created_at AS createdAt, updated_at AS updatedAt
      FROM branch_order_drafts
      WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
    `).get(String(locationId), scope.ownerAccountId, employeeNumber);
    if (!row) return null;
    const availableItems = activeDraftItems(locationId);
    const currentConfigurationUpdatedAt = configurationUpdatedAt(locationId);
    const items = db.prepare(`
      SELECT item_id AS itemId, item_title_snapshot AS itemTitle,
             unit_snapshot AS unit, quantity, note, sort_order AS sortOrder
      FROM branch_order_draft_lines
      WHERE draft_id = ?
      ORDER BY sort_order, item_id
    `).all(String(row.id)).map((line) => {
      const current = availableItems.get(String(line.itemId));
      return {
        ...line,
        quantity: Number(line.quantity),
        sortOrder: Number(line.sortOrder),
        available: Boolean(current),
        currentTitle: current?.title || "",
        currentUnit: current?.unit || "",
      };
    });
    return {
      ...row,
      revision: Number(row.revision),
      configurationChanged: String(row.configurationUpdatedAt || "") !== currentConfigurationUpdatedAt,
      currentConfigurationUpdatedAt,
      items,
      staleItemCount: items.filter((item) => !item.available).length,
    };
  }

  function saveDraft(locationId, input = {}) {
    const draft = preparedDraft(locationId, input);
    transaction(() => {
      const existing = db.prepare(`
        SELECT id, revision
        FROM branch_order_drafts
        WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
      `).get(draft.locationId, draft.ownerAccountId, draft.employee.employeeNumber);
      const actualRevision = Number(existing?.revision || 0);
      if (actualRevision !== draft.expectedRevision) {
        throw branchOrderError(
          "Der gespeicherte Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.",
          "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
          409,
        );
      }
      const now = new Date().toISOString();
      const draftId = existing?.id || crypto.randomUUID();
      const nextRevision = actualRevision + 1;
      if (existing) {
        db.prepare(`
          UPDATE branch_order_drafts
          SET owner_kind = ?, selected_employee_name = ?, week_start_at_save = ?,
              configuration_updated_at = ?, revision = ?, updated_at = ?, updated_by_login = ?
          WHERE id = ?
        `).run(
          draft.ownerKind, draft.employee.fullName, draft.weekStartAtSave,
          draft.configurationUpdatedAt, nextRevision, now, draft.updatedByLogin, draftId,
        );
        db.prepare("DELETE FROM branch_order_draft_lines WHERE draft_id = ?").run(draftId);
      } else {
        db.prepare(`
          INSERT INTO branch_order_drafts
            (id, location_id, owner_account_id, owner_kind,
             selected_employee_number, selected_employee_name,
             week_start_at_save, configuration_updated_at, revision,
             created_at, updated_at, updated_by_login)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          draftId, draft.locationId, draft.ownerAccountId, draft.ownerKind,
          draft.employee.employeeNumber, draft.employee.fullName,
          draft.weekStartAtSave, draft.configurationUpdatedAt, nextRevision,
          now, now, draft.updatedByLogin,
        );
      }
      const insertLine = db.prepare(`
        INSERT INTO branch_order_draft_lines
          (draft_id, item_id, item_title_snapshot, unit_snapshot, quantity, note, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const line of draft.lines) {
        insertLine.run(
          draftId, line.itemId, line.itemTitle, line.unit,
          line.quantity, line.note, line.sortOrder,
        );
      }
    });
    return draftSnapshot(locationId, input);
  }

  function deleteDraft(locationId, input = {}) {
    const scope = normalizedDraftScope(input);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    const expectedRevision = normalizedDraftRevision(input.expectedRevision);
    return transaction(() => {
      const existing = db.prepare(`
        SELECT id, revision
        FROM branch_order_drafts
        WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
      `).get(String(locationId), scope.ownerAccountId, employeeNumber);
      if (!existing) {
        if (expectedRevision > 0) {
          throw branchOrderError(
            "Der gespeicherte Entwurf ist nicht mehr vorhanden. Bitte neu laden.",
            "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
            409,
          );
        }
        return false;
      }
      if (Number(existing.revision) !== expectedRevision) {
        throw branchOrderError(
          "Der gespeicherte Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.",
          "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
          409,
        );
      }
      return Number(db.prepare("DELETE FROM branch_order_drafts WHERE id = ?").run(String(existing.id)).changes || 0) > 0;
    });
  }

  function normalizeConfiguration(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw branchOrderError("Die Bestellkonfiguration ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
    }
    if (!Array.isArray(input.recipients) || !Array.isArray(input.groups)) {
      throw branchOrderError("E-Mail-Ziele und Warengruppen müssen vollständig übermittelt werden.", "BRANCH_ORDER_CONFIGURATION_INVALID");
    }
    if (input.recipients.length > 60 || input.groups.length > 80) {
      throw branchOrderError("Die Bestellkonfiguration ist zu umfangreich.", "BRANCH_ORDER_CONFIGURATION_TOO_LARGE");
    }
    const seenRecipientRefs = new Set();
    const emailSet = new Set();
    const recipientIdByReference = new Map();
    const recipients = input.recipients.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw branchOrderError("Ein E-Mail-Ziel ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      const reference = safeClientReference(source.id, `recipient-${index + 1}`);
      if (seenRecipientRefs.has(reference)) {
        throw branchOrderError("E-Mail-Ziele dürfen nicht doppelt vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      seenRecipientRefs.add(reference);
      const email = normalizedEmail(source.email, "Die Zieladresse");
      if (emailSet.has(email)) {
        throw branchOrderError("Eine Zieladresse darf nur einmal angelegt werden.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      emailSet.add(email);
      const suppliedReplyToEmail = String(source.replyToEmail || "").trim();
      const replyToEmail = suppliedReplyToEmail
        ? normalizedEmail(suppliedReplyToEmail, "Die Antwortadresse")
        : email;
      const recipient = {
        id: crypto.randomUUID(),
        email,
        replyToEmail,
        subjectTemplate: normalizedTemplate(source.subjectTemplate, { subject: true }),
        bodyTemplate: normalizedTemplate(source.bodyTemplate),
      };
      recipientIdByReference.set(reference, recipient.id);
      return recipient;
    });

    const seenGroupRefs = new Set();
    const groups = input.groups.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source) || !Array.isArray(source.items)) {
        throw branchOrderError("Eine Warengruppe ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      if (source.items.length > 160) {
        throw branchOrderError("Eine Warengruppe enthält zu viele Positionen.", "BRANCH_ORDER_CONFIGURATION_TOO_LARGE");
      }
      const reference = safeClientReference(source.id, `group-${index + 1}`);
      if (seenGroupRefs.has(reference)) {
        throw branchOrderError("Warengruppen dürfen nicht doppelt vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      seenGroupRefs.add(reference);
      const recipientReference = String(source.recipientId || "").trim();
      const recipientId = recipientReference ? recipientIdByReference.get(recipientReference) : null;
      if (recipientReference && !recipientId) {
        throw branchOrderError("Eine Warengruppe verweist auf ein unbekanntes E-Mail-Ziel.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      const seenItemRefs = new Set();
      const items = source.items.map((item, itemIndex) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
          throw branchOrderError("Eine Bestellposition ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
        }
        const itemReference = safeClientReference(item.id, `item-${itemIndex + 1}`);
        if (seenItemRefs.has(itemReference)) {
          throw branchOrderError("Bestellpositionen dürfen in einer Warengruppe nicht doppelt vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
        }
        seenItemRefs.add(itemReference);
        return {
          id: crypto.randomUUID(),
          title: textValue(item.title, { label: "Die Bestellposition", minimum: 2, maximum: 180 }),
          unit: normalizedUnit(item.unit),
        };
      });
      return {
        id: crypto.randomUUID(),
        recipientId: recipientId || null,
        title: textValue(source.title, { label: "Die Warengruppe", minimum: 2, maximum: 120 }),
        hint: textValue(source.hint, { label: "Der Hinweis", maximum: 400 }),
        items,
      };
    });
    return { recipients, groups };
  }

  function replaceConfiguration(locationId, input, actor = "") {
    ensureLocationConfiguration(locationId, actor || "system");
    const normalized = normalizeConfiguration(input);
    const now = new Date().toISOString();
    transaction(() => {
      db.prepare("DELETE FROM branch_order_groups WHERE location_id = ?").run(String(locationId));
      db.prepare("DELETE FROM branch_order_recipients WHERE location_id = ?").run(String(locationId));
      for (const recipient of normalized.recipients) {
        db.prepare(`
          INSERT INTO branch_order_recipients
            (id, location_id, email, reply_to_email, subject_template, body_template,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recipient.id, String(locationId), recipient.email, recipient.replyToEmail,
          recipient.subjectTemplate, recipient.bodyTemplate, now, actor, now, actor,
        );
      }
      for (const [groupIndex, group] of normalized.groups.entries()) {
        db.prepare(`
          INSERT INTO branch_order_groups
            (id, location_id, recipient_id, title, hint, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          group.id, String(locationId), group.recipientId, group.title, group.hint,
          groupIndex + 1, now, actor, now, actor,
        );
        for (const [itemIndex, item] of group.items.entries()) {
          db.prepare(`
            INSERT INTO branch_order_items
              (id, group_id, title, unit, active, sort_order,
               created_at, created_by, updated_at, updated_by)
            VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          `).run(item.id, group.id, item.title, item.unit, itemIndex + 1, now, actor, now, actor);
        }
      }
      db.prepare(`
        UPDATE branch_order_location_settings
        SET updated_at = ?, updated_by = ?
        WHERE location_id = ?
      `).run(now, actor, String(locationId));
    });
    return settingsSnapshot(locationId);
  }

  function preparedOrder(locationId, input = {}) {
    ensureLocationConfiguration(locationId);
    const location = locationRow(locationId);
    if (!location) throw branchOrderError("Die Filiale ist nicht aktiv.", "BRANCH_ORDER_LOCATION_INVALID", 404);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    const employee = activeEmployeeRow(locationId, employeeNumber);
    if (!employee) {
      throw branchOrderError(
        "Die ausgewählte Person ist für diese Filiale nicht aktiv.",
        "BRANCH_ORDER_EMPLOYEE_SCOPE_DENIED",
        403,
      );
    }
    if (!Array.isArray(input.items) || !input.items.length || input.items.length > 200) {
      throw branchOrderError("Bitte mindestens eine Bestellposition mit Menge auswählen.", "BRANCH_ORDER_ITEMS_REQUIRED");
    }
    const configuration = settingsSnapshot(locationId);
    const recipientsById = new Map(configuration.recipients.map((recipient) => [recipient.id, recipient]));
    const activeItems = new Map();
    for (const group of configuration.groups.filter((group) => group.active)) {
      for (const item of group.items.filter((item) => item.active)) {
        activeItems.set(item.id, { group, item, recipient: recipientsById.get(group.recipientId) || null });
      }
    }
    const selectedIds = new Set();
    const lines = input.items.map((entry, index) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw branchOrderError("Eine Bestellposition ist ungültig.", "BRANCH_ORDER_ITEMS_INVALID");
      }
      const itemId = textValue(entry.itemId, { label: "Die Bestellposition", minimum: 1, maximum: 160 });
      if (selectedIds.has(itemId)) {
        throw branchOrderError("Eine Bestellposition darf nur einmal übermittelt werden.", "BRANCH_ORDER_ITEMS_INVALID");
      }
      selectedIds.add(itemId);
      const configured = activeItems.get(itemId);
      if (!configured) {
        throw branchOrderError("Eine Bestellposition ist nicht mehr verfügbar. Bitte die Seite aktualisieren.", "BRANCH_ORDER_ITEM_NOT_FOUND", 409);
      }
      if (!configured.recipient || !validEmail(configured.recipient.email) || !validEmail(configured.recipient.replyToEmail)) {
        throw branchOrderError(
          `Für die Warengruppe „${configured.group.title}“ fehlt ein vollständiges E-Mail-Ziel mit Antwortadresse.`,
          "BRANCH_ORDER_RECIPIENT_REQUIRED",
          409,
        );
      }
      return {
        id: crypto.randomUUID(),
        recipient: configured.recipient,
        groupTitle: configured.group.title,
        itemTitle: configured.item.title,
        quantity: normalizedQuantity(entry.quantity),
        unit: configured.item.unit,
        note: textValue(entry.note, { label: "Die Bemerkung", maximum: 500 }),
        sortOrder: index + 1,
      };
    });
    const deliveryLines = new Map();
    for (const line of lines) {
      if (!deliveryLines.has(line.recipient.id)) deliveryLines.set(line.recipient.id, []);
      deliveryLines.get(line.recipient.id).push(line);
    }
    const submittedAt = textValue(input.submittedAt || new Date().toISOString(), {
      label: "Der Erfassungszeitpunkt", minimum: 10, maximum: 80,
    });
    const deliveries = [...deliveryLines.values()].map((recipientLines) => {
      const recipient = recipientLines[0].recipient;
      const grouped = new Map();
      for (const line of recipientLines) {
        if (!grouped.has(line.groupTitle)) grouped.set(line.groupTitle, []);
        grouped.get(line.groupTitle).push(line);
      }
      const itemsText = [...grouped.entries()].map(([groupTitle, groupLines]) => [
        groupTitle,
        ...groupLines.map((line) => `- ${line.itemTitle}: ${numberText(line.quantity)} ${line.unit}${line.note ? ` (${line.note})` : ""}`),
      ].join("\n")).join("\n\n");
      const templateValues = {
        locationName: location.name,
        calendarWeek: String(input.calendarWeek),
        weekStart: String(input.weekStart),
        employeeName: employee.fullName,
        employeeNumber: employee.employeeNumber,
        submittedAt,
        items: itemsText,
      };
      const subject = renderTemplate(recipient.subjectTemplate, templateValues).trim().slice(0, 180);
      const body = `${renderTemplate(recipient.bodyTemplate, templateValues).trim()}${orderMailFooter(recipient.replyToEmail)}`;
      if (!subject || /[\r\n]/.test(subject) || !body.trim() || body.length > 12000) {
        throw branchOrderError("Die E-Mail-Vorlage erzeugt keinen gültigen Versandinhalt.", "BRANCH_ORDER_TEMPLATE_INVALID", 409);
      }
      return {
        id: crypto.randomUUID(),
        senderEmail: normalizedEmail(input.senderEmail, "Der Absender"),
        recipientEmail: recipient.email,
        replyToEmail: recipient.replyToEmail,
        subject,
        body,
      };
    });
    const submittedByAccountId = textValue(input.submittedByAccountId, {
      label: "Der Filialzugang", minimum: 1, maximum: 160,
    });
    const submittedByLogin = textValue(input.submittedByLogin, {
      label: "Der Filialzugang", minimum: 1, maximum: 80,
    });
    const draftScope = normalizedDraftScope({
      ownerKind: input.draftOwnerKind,
      ownerAccountId: submittedByAccountId,
      updatedByLogin: submittedByLogin,
    });
    return {
      id: crypto.randomUUID(),
      location: { id: String(location.id), name: String(location.name) },
      employee: { employeeNumber: String(employee.employeeNumber), fullName: String(employee.fullName) },
      lines,
      deliveries,
      weekStart: textValue(input.weekStart, { label: "Die Kalenderwoche", minimum: 10, maximum: 10 }),
      calendarWeek: Number(input.calendarWeek),
      submittedAt,
      submittedByAccountId,
      submittedByLogin,
      draftScope,
      expectedDraftRevision: normalizedDraftRevision(input.draftRevision ?? 0),
    };
  }

  async function createOrder(locationId, input = {}) {
    const order = preparedOrder(locationId, input);
    if (!Number.isInteger(order.calendarWeek) || order.calendarWeek < 1 || order.calendarWeek > 53) {
      throw branchOrderError("Die Kalenderwoche ist ungültig.", "BRANCH_ORDER_WEEK_INVALID");
    }
    let pdfContent;
    try {
      pdfContent = await renderBranchOrderPdf(order);
    } catch (error) {
      throw branchOrderError(
        "Der Bestellnachweis konnte nicht erzeugt werden.",
        "BRANCH_ORDER_PDF_GENERATION_FAILED",
        500,
      );
    }
    const pdfFilename = buildBranchOrderPdfFilename(order);
    const pdfSha256 = branchOrderPdfSha256(pdfContent);
    const pdfGeneratedAt = order.submittedAt;
    let draftConsumed = false;
    transaction(() => {
      const savedDraft = db.prepare(`
        SELECT id, revision
        FROM branch_order_drafts
        WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
      `).get(order.location.id, order.draftScope.ownerAccountId, order.employee.employeeNumber);
      const actualDraftRevision = Number(savedDraft?.revision || 0);
      if (actualDraftRevision !== order.expectedDraftRevision) {
        throw branchOrderError(
          "Der gespeicherte Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.",
          "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
          409,
        );
      }
      db.prepare(`
        INSERT INTO branch_orders
          (id, location_id, week_start, calendar_week,
           selected_employee_number, selected_employee_name,
           submitted_by_account_id, submitted_by_login, status, submitted_at, updated_at,
           pdf_filename, pdf_sha256, pdf_content, pdf_generated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?)
      `).run(
        order.id, order.location.id, order.weekStart, order.calendarWeek,
        order.employee.employeeNumber, order.employee.fullName,
        order.submittedByAccountId, order.submittedByLogin,
        order.submittedAt, order.submittedAt,
        pdfFilename, pdfSha256, pdfContent, pdfGeneratedAt,
      );
      for (const line of order.lines) {
        db.prepare(`
          INSERT INTO branch_order_lines
            (id, order_id, recipient_email, group_title, item_title, quantity, unit, note, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          line.id, order.id, line.recipient.email, line.groupTitle, line.itemTitle,
          line.quantity, line.unit, line.note, line.sortOrder,
        );
      }
      for (const delivery of order.deliveries) {
        db.prepare(`
          INSERT INTO branch_order_deliveries
            (id, order_id, sender_email, recipient_email, reply_to_email, subject_snapshot, body_snapshot,
             status, failure_code, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
        `).run(
          delivery.id, order.id, delivery.senderEmail, delivery.recipientEmail, delivery.replyToEmail,
          delivery.subject, delivery.body, order.submittedAt, order.submittedAt,
        );
      }
      if (savedDraft) {
        const deleted = db.prepare(`
          DELETE FROM branch_order_drafts
          WHERE id = ? AND revision = ?
        `).run(String(savedDraft.id), actualDraftRevision);
        if (Number(deleted.changes || 0) !== 1) {
          throw branchOrderError(
            "Der gespeicherte Entwurf konnte nicht abgeschlossen werden. Bitte neu laden.",
            "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
            409,
          );
        }
        draftConsumed = true;
      }
    });
    order.pdf = {
      filename: pdfFilename,
      sha256: pdfSha256,
      generatedAt: pdfGeneratedAt,
    };
    order.draftConsumed = draftConsumed;
    return order;
  }

  function markDelivery(deliveryId, { status, failureCode = "", attemptedAt = new Date().toISOString() } = {}) {
    if (!["sent", "failed"].includes(status)) {
      throw branchOrderError("Der Versandstatus ist ungültig.", "BRANCH_ORDER_DELIVERY_INVALID");
    }
    const result = db.prepare(`
      UPDATE branch_order_deliveries
      SET status = ?, failure_code = ?, attempted_at = ?,
          sent_at = CASE WHEN ? = 'sent' THEN ? ELSE NULL END,
          updated_at = ?
      WHERE id = ?
    `).run(
      status,
      status === "failed" ? textValue(failureCode, { label: "Der Versandfehler", maximum: 120 }) : "",
      attemptedAt,
      status,
      attemptedAt,
      attemptedAt,
      String(deliveryId),
    );
    return Number(result.changes || 0) > 0;
  }

  function finalizeOrder(orderId, updatedAt = new Date().toISOString()) {
    const aggregate = db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sentCount,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount
      FROM branch_order_deliveries
      WHERE order_id = ?
    `).get(String(orderId));
    const count = Number(aggregate?.count || 0);
    const sentCount = Number(aggregate?.sentCount || 0);
    const status = count > 0 && sentCount === count
      ? "sent"
      : sentCount > 0
        ? "partial"
        : "failed";
    db.prepare(`
      UPDATE branch_orders
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, updatedAt, String(orderId));
    return {
      status,
      total: count,
      sent: sentCount,
      failed: Number(aggregate?.failedCount || 0),
    };
  }

  function history(locationId, limit = 50, { selectedEmployeeNumber = "" } = {}) {
    const safeLimit = Number.isSafeInteger(Number(limit))
      ? Math.max(1, Math.min(100, Number(limit)))
      : 50;
    const scopedEmployeeNumber = String(selectedEmployeeNumber || "").trim();
    const orders = db.prepare(`
      SELECT id, location_id AS locationId, week_start AS weekStart, calendar_week AS calendarWeek,
              selected_employee_number AS selectedEmployeeNumber,
              selected_employee_name AS selectedEmployeeName,
              submitted_by_login AS submittedByLogin, status,
              submitted_at AS submittedAt, updated_at AS updatedAt,
              pdf_filename AS pdfFilename, pdf_generated_at AS pdfGeneratedAt,
              CASE WHEN pdf_content IS NOT NULL AND length(pdf_content) > 0 THEN 1 ELSE 0 END AS pdfAvailable
      FROM branch_orders
      WHERE location_id = ?${scopedEmployeeNumber ? " AND selected_employee_number = ?" : ""}
      ORDER BY submitted_at DESC, id DESC
      LIMIT ?
    `).all(...(scopedEmployeeNumber
      ? [String(locationId), scopedEmployeeNumber, safeLimit]
      : [String(locationId), safeLimit])).map((row) => ({
      ...row,
      calendarWeek: Number(row.calendarWeek),
      pdfAvailable: Boolean(row.pdfAvailable),
      lines: [],
      deliveries: [],
    }));
    const byId = new Map(orders.map((order) => [order.id, order]));
    const linesForOrder = db.prepare(`
      SELECT recipient_email AS recipientEmail, group_title AS groupTitle,
             item_title AS itemTitle, quantity, unit, note, sort_order AS sortOrder
      FROM branch_order_lines
      WHERE order_id = ?
      ORDER BY sort_order, id
    `);
    const deliveriesForOrder = db.prepare(`
      SELECT sender_email AS senderEmail, recipient_email AS recipientEmail, reply_to_email AS replyToEmail,
             status, failure_code AS failureCode, attempted_at AS attemptedAt, sent_at AS sentAt
      FROM branch_order_deliveries
      WHERE order_id = ?
      ORDER BY id
    `);
    for (const order of byId.values()) {
      order.lines = linesForOrder.all(order.id).map((line) => ({
        ...line,
        quantity: Number(line.quantity),
        sortOrder: Number(line.sortOrder),
      }));
      order.deliveries = deliveriesForOrder.all(order.id);
    }
    return orders;
  }

  function orderForPdf(locationId, orderId, { selectedEmployeeNumber = "" } = {}) {
    const scopedEmployeeNumber = String(selectedEmployeeNumber || "").trim();
    const order = db.prepare(`
      SELECT branch_order.id, branch_order.location_id AS locationId,
             location.name AS locationName,
             branch_order.week_start AS weekStart,
             branch_order.calendar_week AS calendarWeek,
             branch_order.selected_employee_number AS selectedEmployeeNumber,
             branch_order.selected_employee_name AS selectedEmployeeName,
             branch_order.submitted_by_login AS submittedByLogin,
             branch_order.submitted_at AS submittedAt,
             branch_order.pdf_filename AS pdfFilename,
             branch_order.pdf_sha256 AS pdfSha256,
             branch_order.pdf_content AS pdfContent,
             branch_order.pdf_generated_at AS pdfGeneratedAt
      FROM branch_orders branch_order
      JOIN locations location ON location.id = branch_order.location_id
      WHERE branch_order.id = ? AND branch_order.location_id = ?${scopedEmployeeNumber ? " AND branch_order.selected_employee_number = ?" : ""}
    `).get(...(scopedEmployeeNumber
      ? [String(orderId), String(locationId), scopedEmployeeNumber]
      : [String(orderId), String(locationId)]));
    if (!order) {
      throw branchOrderError("Die Bestellung wurde für diesen Standort nicht gefunden.", "BRANCH_ORDER_NOT_FOUND", 404);
    }
    order.lines = db.prepare(`
      SELECT group_title AS groupTitle, item_title AS itemTitle, quantity, unit, note,
             sort_order AS sortOrder
      FROM branch_order_lines
      WHERE order_id = ?
      ORDER BY sort_order, id
    `).all(order.id).map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      sortOrder: Number(line.sortOrder),
    }));
    return order;
  }

  async function orderPdf(locationId, orderId, options = {}) {
    const order = orderForPdf(locationId, orderId, options);
    const existingContent = order.pdfContent ? Buffer.from(order.pdfContent) : null;
    if (existingContent?.length) {
      return {
        filename: String(order.pdfFilename || buildBranchOrderPdfFilename({
          id: order.id,
          location: { id: order.locationId },
          calendarWeek: Number(order.calendarWeek),
        })),
        sha256: String(order.pdfSha256 || branchOrderPdfSha256(existingContent)),
        generatedAt: order.pdfGeneratedAt || order.submittedAt,
        content: existingContent,
      };
    }
    let content;
    try {
      content = await renderBranchOrderPdf({
        id: order.id,
        location: { id: order.locationId, name: order.locationName },
        employee: {
          employeeNumber: order.selectedEmployeeNumber,
          fullName: order.selectedEmployeeName,
        },
        calendarWeek: Number(order.calendarWeek),
        weekStart: order.weekStart,
        submittedAt: order.submittedAt,
        submittedByLogin: order.submittedByLogin,
        lines: order.lines,
      });
    } catch (error) {
      throw branchOrderError(
        "Der gespeicherte Bestellnachweis konnte nicht wiederhergestellt werden.",
        "BRANCH_ORDER_PDF_GENERATION_FAILED",
        500,
      );
    }
    const filename = buildBranchOrderPdfFilename({
      id: order.id,
      location: { id: order.locationId },
      calendarWeek: Number(order.calendarWeek),
    });
    const sha256 = branchOrderPdfSha256(content);
    const generatedAt = new Date().toISOString();
    db.prepare(`
      UPDATE branch_orders
      SET pdf_filename = ?, pdf_sha256 = ?, pdf_content = ?, pdf_generated_at = ?
      WHERE id = ? AND location_id = ?
    `).run(filename, sha256, content, generatedAt, order.id, String(locationId));
    return { filename, sha256, generatedAt, content };
  }

  return Object.freeze({
    catalogSnapshot,
    createOrder,
    deleteDraft,
    draftSnapshot,
    ensureActiveBranchAccountBasePermissions,
    ensureLocationConfiguration,
    finalizeOrder,
    history,
    markDelivery,
    orderPdf,
    replaceConfiguration,
    saveDraft,
    settingsSnapshot,
  });
}

module.exports = {
  BRANCH_ORDER_UNITS,
  BranchOrderError,
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_SUBJECT_TEMPLATE,
  createSqliteBranchOrderOperations,
  ensureSqliteBranchOrdersSchema,
};
