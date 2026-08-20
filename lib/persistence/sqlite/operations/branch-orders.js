"use strict";

const crypto = require("node:crypto");
const {
  branchOrderPdfSha256,
  buildBranchOrderPdfFilename,
  renderBranchOrderPdf,
} = require("../../../branch-order-pdf");

const DEFAULT_BRANCH_ORDER_UNITS = Object.freeze([
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

// Kept as a compatibility export. Units are now maintained per location.
const BRANCH_ORDER_UNITS = DEFAULT_BRANCH_ORDER_UNITS;

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
  "employeeNickname",
  "employeeNumber",
  "submittedAt",
  "items",
]);

const DEFAULT_BRANCH_ORDER_RECIPIENTS = Object.freeze([
  Object.freeze({ key: "lager", email: "lager@lamprechter.com" }),
  Object.freeze({ key: "marketing", email: "team-marketing@lamprechter.com" }),
]);

const DEFAULT_BRANCH_ORDER_GROUPS = Object.freeze([
  Object.freeze({ key: "plotter", title: "Fotowelt – Plotter", hint: "Tinten, Rollen, Blattware und Plotterzubehör" }),
  Object.freeze({ key: "packaging", title: "Fotowelt – Verpackung & Versand", hint: "Verpackungs- und Versandmaterial" }),
  Object.freeze({ key: "instant", title: "Fotowelt – Sofortdruck", hint: "Mediasets und Sofortdruckmaterial" }),
  Object.freeze({ key: "cashdesk", title: "Fotowelt – Kassa & Büro", hint: "Kassa, interne Drucker und Arbeitsmaterial" }),
  Object.freeze({ key: "marketing", title: "Fotowelt – Marketing & Kundeninformation", hint: "Kundenunterlagen, Kataloge und Gutscheine" }),
  Object.freeze({ key: "other", title: "Fotowelt – Weitere Positionen", hint: "Weitere freigegebene Bestellpositionen" }),
]);

const DEFAULT_BRANCH_ORDER_ITEMS = Object.freeze([
  Object.freeze({ title: "Batteriesammelbehälter", unit: "Stück", recipient: "lager", groups: ["cashdesk"] }),
  Object.freeze({ title: "Bildertaschen für Sofortdruck", unit: "Packung", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Briefkuverts / Kuverts", unit: "Packung", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Fotodrucker: Mediaset DS40", unit: "Packung", recipient: "lager", groups: ["instant"] }),
  Object.freeze({ title: "Fotodrucker: Mediaset DS80", unit: "Packung", recipient: "lager", groups: ["instant"] }),
  Object.freeze({ title: "Fotodrucker: Mediaset DS620", unit: "Packung", recipient: "lager", groups: ["instant"] }),
  Object.freeze({ title: "Hutpapier", unit: "Rolle", recipient: "lager", groups: ["plotter", "packaging"] }),
  Object.freeze({ title: "Kartonagen für Versand", unit: "Karton", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Kassarollen", unit: "Rolle", recipient: "lager", groups: ["cashdesk"] }),
  Object.freeze({ title: "Thermorollen für Bondrucker / Kassa", unit: "Rolle", recipient: "lager", groups: ["cashdesk"] }),
  Object.freeze({ title: "Klebeband braun", unit: "Rolle", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Klebeband transparent", unit: "Rolle", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Papier 80 g A4 für interne Drucker", unit: "Packung", recipient: "lager", groups: ["cashdesk"] }),
  Object.freeze({ title: "Papier 80 g A3 für interne Drucker", unit: "Packung", recipient: "lager", groups: ["cashdesk"] }),
  Object.freeze({ title: "Plotterpapier", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Plottertinten Canon", unit: "Stück", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Plotter-Wartungsbehälter", unit: "Stück", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Plotter: Sonstiges", unit: "Einheit", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Rollen für Preisauszeichner", unit: "Rolle", recipient: "lager", groups: ["cashdesk"] }),
  Object.freeze({ title: "Verpackungsmaterial", unit: "Packung", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Versandtaschen für analoge Filme", unit: "Packung", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Versandtaschen gelb, gepolstert", unit: "Packung", recipient: "lager", groups: ["packaging"] }),
  Object.freeze({ title: "Bilderbonuskarten", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Bilderwelten Kataloge", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Dienstleistungsflyer", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Flyer Fotobook", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Flyer Kurse", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Foto Connection Kataloge", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Geschenk-Gutscheine € 10", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Geschenk-Gutscheine € 30", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Geschenk-Gutscheine € 50", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Geschenk-Gutscheine € 100", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Gutscheine: Gratis analoge Entwicklung", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Gutscheine: HD-Premium", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Gutscheine: Sensorreinigung", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Kundenanlageformular", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Kundenbestellblöcke", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Notizblöcke", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Passbildeinleger", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Passbildhüllen", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Passbildkleber", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Visitenkarten", unit: "Packung", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Warenbegleitformulare", unit: "Block", recipient: "marketing", groups: ["marketing"] }),
  Object.freeze({ title: "Büromaterial: Tixo, Heftklammern, Gummibänder, …", unit: "Einheit", recipient: "lager", groups: ["other"] }),
  Object.freeze({ title: "Formulare (Wissensdatenbank → Formulare)", unit: "Einheit", recipient: "lager", groups: ["other"] }),
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
      updated_by TEXT NOT NULL,
      schedule_display_mode TEXT NOT NULL DEFAULT 'classic'
        CHECK (schedule_display_mode IN ('classic', 'colored')),
      mobile_hide_elapsed_days INTEGER NOT NULL DEFAULT 0
        CHECK (mobile_hide_elapsed_days IN (0, 1)),
      order_autosave_enabled INTEGER NOT NULL DEFAULT 0
        CHECK (order_autosave_enabled IN (0, 1)),
      order_autosave_minutes INTEGER NOT NULL DEFAULT 10
        CHECK (order_autosave_minutes BETWEEN 1 AND 99)
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

    -- The legacy item table above stays in place for historical upgrades. New
    -- catalog items are location-wide and may be shown in more than one group.
    CREATE TABLE IF NOT EXISTS branch_order_units (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      title TEXT NOT NULL COLLATE NOCASE,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL,
      UNIQUE(location_id, title)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_units_location
      ON branch_order_units(location_id, active, sort_order, id);

    CREATE TABLE IF NOT EXISTS branch_order_catalog_items (
      id TEXT PRIMARY KEY,
      location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
      recipient_id TEXT REFERENCES branch_order_recipients(id) ON DELETE SET NULL,
      unit_id TEXT NOT NULL REFERENCES branch_order_units(id) ON DELETE RESTRICT,
      title TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 1 CHECK (active IN (0, 1)),
      sort_order INTEGER NOT NULL,
      created_at TEXT NOT NULL,
      created_by TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_catalog_items_location
      ON branch_order_catalog_items(location_id, active, sort_order, id);

    CREATE TABLE IF NOT EXISTS branch_order_group_items (
      group_id TEXT NOT NULL REFERENCES branch_order_groups(id) ON DELETE CASCADE,
      item_id TEXT NOT NULL REFERENCES branch_order_catalog_items(id) ON DELETE CASCADE,
      sort_order INTEGER NOT NULL,
      PRIMARY KEY(group_id, item_id)
    );
    CREATE INDEX IF NOT EXISTS idx_branch_order_group_items_group
      ON branch_order_group_items(group_id, sort_order, item_id);

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
  const locationSettingsColumns = new Set(
    db.prepare("PRAGMA table_info(branch_order_location_settings)").all()
      .map((column) => String(column.name)),
  );
  if (!locationSettingsColumns.has("schedule_display_mode")) {
    db.exec("ALTER TABLE branch_order_location_settings ADD COLUMN schedule_display_mode TEXT NOT NULL DEFAULT 'classic'");
  }
  if (!locationSettingsColumns.has("mobile_hide_elapsed_days")) {
    db.exec("ALTER TABLE branch_order_location_settings ADD COLUMN mobile_hide_elapsed_days INTEGER NOT NULL DEFAULT 0");
  }
  if (!locationSettingsColumns.has("order_autosave_enabled")) {
    db.exec("ALTER TABLE branch_order_location_settings ADD COLUMN order_autosave_enabled INTEGER NOT NULL DEFAULT 0");
  }
  if (!locationSettingsColumns.has("order_autosave_minutes")) {
    db.exec("ALTER TABLE branch_order_location_settings ADD COLUMN order_autosave_minutes INTEGER NOT NULL DEFAULT 10");
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

  function insertUnit(locationId, title, sortOrder, now, actor) {
    const id = crypto.randomUUID();
    db.prepare(`
      INSERT INTO branch_order_units
        (id, location_id, title, active, sort_order, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(id, locationId, title, sortOrder, now, actor, now, actor);
    return id;
  }

  function seedDefaultCatalog(locationId, actor, now) {
    const recipientIds = new Map();
    for (const recipient of DEFAULT_BRANCH_ORDER_RECIPIENTS) {
      const id = crypto.randomUUID();
      recipientIds.set(recipient.key, id);
      db.prepare(`
        INSERT INTO branch_order_recipients
          (id, location_id, email, reply_to_email, subject_template, body_template,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, locationId, recipient.email, recipient.email,
        DEFAULT_SUBJECT_TEMPLATE, DEFAULT_BODY_TEMPLATE, now, actor, now, actor,
      );
    }
    const unitIds = new Map();
    DEFAULT_BRANCH_ORDER_UNITS.forEach((unit, index) => unitIds.set(
      unit,
      insertUnit(locationId, unit, index + 1, now, actor),
    ));
    const groupIds = new Map();
    DEFAULT_BRANCH_ORDER_GROUPS.forEach((group, index) => {
      const id = crypto.randomUUID();
      groupIds.set(group.key, id);
      db.prepare(`
        INSERT INTO branch_order_groups
          (id, location_id, recipient_id, title, hint, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(id, locationId, group.title, group.hint, index + 1, now, actor, now, actor);
    });
    const groupSort = new Map();
    for (const item of DEFAULT_BRANCH_ORDER_ITEMS) {
      const itemId = crypto.randomUUID();
      db.prepare(`
        INSERT INTO branch_order_catalog_items
          (id, location_id, recipient_id, unit_id, title, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        itemId, locationId, recipientIds.get(item.recipient) || null, unitIds.get(item.unit),
        item.title, DEFAULT_BRANCH_ORDER_ITEMS.indexOf(item) + 1, now, actor, now, actor,
      );
      for (const groupKey of item.groups) {
        const groupId = groupIds.get(groupKey);
        const nextSort = Number(groupSort.get(groupId) || 0) + 1;
        groupSort.set(groupId, nextSort);
        db.prepare(`
          INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
          VALUES (?, ?, ?)
        `).run(groupId, itemId, nextSort);
      }
    }
  }

  function legacyCatalogRows(locationId) {
    return db.prepare(`
      SELECT grouping.id AS groupId, grouping.recipient_id AS recipientId,
             grouping.title AS groupTitle, grouping.hint AS groupHint,
             grouping.active AS groupActive, grouping.sort_order AS groupSortOrder,
             item.id AS itemId, item.title AS itemTitle, item.unit AS unit,
             item.active AS itemActive, item.sort_order AS itemSortOrder
      FROM branch_order_groups grouping
      JOIN branch_order_items item ON item.group_id = grouping.id
      WHERE grouping.location_id = ?
      ORDER BY grouping.sort_order, item.sort_order, item.id
    `).all(locationId);
  }

  function migrateLegacyCatalog(locationId, actor, now) {
    const rows = legacyCatalogRows(locationId);
    if (!rows.length) {
      seedDefaultCatalog(locationId, actor, now);
      return;
    }
    const unitIds = new Map();
    const unitTitles = [...new Set([...DEFAULT_BRANCH_ORDER_UNITS, ...rows.map((row) => String(row.unit))])];
    unitTitles.forEach((unit, index) => unitIds.set(unit, insertUnit(locationId, unit, index + 1, now, actor)));
    const itemRows = new Map();
    for (const row of rows) {
      if (itemRows.has(String(row.itemId))) continue;
      db.prepare(`
        INSERT INTO branch_order_catalog_items
          (id, location_id, recipient_id, unit_id, title, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.itemId, locationId, row.recipientId || null, unitIds.get(String(row.unit)),
        row.itemTitle, Number(row.itemActive) ? 1 : 0, Number(row.itemSortOrder), now, actor, now, actor,
      );
      itemRows.set(String(row.itemId), row);
    }
    const legacyGroups = [...new Map(rows.map((row) => [String(row.groupId), row])).values()];
    const legacyTitles = new Set(legacyGroups.map((row) => String(row.groupTitle)));
    const isOldDefault = legacyTitles.size === 3
      && ["Lager", "Marketing", "Sonstiges"].every((title) => legacyTitles.has(title));
    if (!isOldDefault) {
      for (const row of rows) {
        db.prepare(`
          INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
          VALUES (?, ?, ?)
        `).run(row.groupId, row.itemId, Number(row.itemSortOrder));
      }
      return;
    }
    const recipientIdByKey = new Map();
    const recipients = db.prepare(`SELECT id, email FROM branch_order_recipients WHERE location_id = ?`).all(locationId);
    for (const defaultRecipient of DEFAULT_BRANCH_ORDER_RECIPIENTS) {
      const matched = recipients.find((recipient) => String(recipient.email).toLowerCase() === defaultRecipient.email);
      if (matched) recipientIdByKey.set(defaultRecipient.key, matched.id);
    }
    const legacyWarehouseRecipient = legacyGroups.find((row) => row.groupTitle === "Lager")?.recipientId || null;
    const legacyMarketingRecipient = legacyGroups.find((row) => row.groupTitle === "Marketing")?.recipientId || null;
    const byTitle = new Map([...itemRows.values()].map((row) => [String(row.itemTitle), row]));
    const groupIds = new Map();
    DEFAULT_BRANCH_ORDER_GROUPS.forEach((group, index) => {
      const id = crypto.randomUUID();
      groupIds.set(group.key, id);
      db.prepare(`
        INSERT INTO branch_order_groups
          (id, location_id, recipient_id, title, hint, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(id, locationId, group.title, group.hint, index + 1, now, actor, now, actor);
    });
    const groupSort = new Map();
    const assignedLegacyItemIds = new Set();
    for (const definition of DEFAULT_BRANCH_ORDER_ITEMS) {
      let source = byTitle.get(definition.title);
      let itemId = source?.itemId;
      if (!source) {
        itemId = crypto.randomUUID();
        db.prepare(`
          INSERT INTO branch_order_catalog_items
            (id, location_id, recipient_id, unit_id, title, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          itemId, locationId,
          recipientIdByKey.get(definition.recipient)
            || (definition.recipient === "marketing" ? legacyMarketingRecipient : legacyWarehouseRecipient),
          unitIds.get(definition.unit), definition.title, DEFAULT_BRANCH_ORDER_ITEMS.indexOf(definition) + 1,
          now, actor, now, actor,
        );
      } else {
        assignedLegacyItemIds.add(String(itemId));
        db.prepare(`
          UPDATE branch_order_catalog_items
          SET recipient_id = COALESCE(?, recipient_id), unit_id = ?, updated_at = ?, updated_by = ?
          WHERE id = ? AND location_id = ?
        `).run(
          recipientIdByKey.get(definition.recipient)
            || (definition.recipient === "marketing" ? legacyMarketingRecipient : legacyWarehouseRecipient),
          unitIds.get(String(source.unit)) || unitIds.get(definition.unit), now, actor, itemId, locationId,
        );
      }
      for (const groupKey of definition.groups) {
        const groupId = groupIds.get(groupKey);
        const sortOrder = Number(groupSort.get(groupId) || 0) + 1;
        groupSort.set(groupId, sortOrder);
        db.prepare(`INSERT INTO branch_order_group_items (group_id, item_id, sort_order) VALUES (?, ?, ?)`)
          .run(groupId, itemId, sortOrder);
      }
    }
    // Do not silently hide positions that were added to the old default
    // categories before the central catalog existed. They remain available in a
    // meaningful new group and can then be placed elsewhere in the PL+ editor.
    const fallbackGroupByLegacyTitle = new Map([
      ["Marketing", groupIds.get("marketing")],
      ["Lager", groupIds.get("other")],
      ["Sonstiges", groupIds.get("other")],
    ]);
    for (const source of itemRows.values()) {
      if (assignedLegacyItemIds.has(String(source.itemId))) continue;
      const groupId = fallbackGroupByLegacyTitle.get(String(source.groupTitle)) || groupIds.get("other");
      const sortOrder = Number(groupSort.get(groupId) || 0) + 1;
      groupSort.set(groupId, sortOrder);
      db.prepare(`INSERT INTO branch_order_group_items (group_id, item_id, sort_order) VALUES (?, ?, ?)`)
        .run(groupId, source.itemId, sortOrder);
    }
    db.prepare(`DELETE FROM branch_order_groups WHERE location_id = ? AND id IN (${legacyGroups.map(() => "?").join(",")})`)
      .run(locationId, ...legacyGroups.map((row) => row.groupId));
  }

  function ensureCatalogConfiguration(locationId, actor = "system") {
    const count = Number(db.prepare(`
      SELECT COUNT(*) AS count FROM branch_order_catalog_items WHERE location_id = ?
    `).get(locationId)?.count || 0);
    if (count) return false;
    return transaction(() => {
      const existing = Number(db.prepare(`
        SELECT COUNT(*) AS count FROM branch_order_catalog_items WHERE location_id = ?
      `).get(locationId)?.count || 0);
      if (existing) return false;
      const now = new Date().toISOString();
      migrateLegacyCatalog(locationId, actor, now);
      db.prepare(`
        UPDATE branch_order_location_settings SET updated_at = ?, updated_by = ? WHERE location_id = ?
      `).run(now, actor, locationId);
      return true;
    });
  }

  function ensureLocationConfiguration(locationId, actor = "system") {
    const normalizedLocationId = String(locationId || "").trim();
    if (!normalizedLocationId) throw branchOrderError("Die Filiale fehlt.", "BRANCH_ORDER_LOCATION_REQUIRED");
    if (hasLocationSettings(normalizedLocationId)) {
      ensureCatalogConfiguration(normalizedLocationId, actor);
      return false;
    }
    return transaction(() => {
      if (hasLocationSettings(normalizedLocationId)) return false;
      const now = new Date().toISOString();
      db.prepare(`
        INSERT INTO branch_order_location_settings
          (location_id, initialized_at, initialized_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(normalizedLocationId, now, actor, now, actor);
      seedDefaultCatalog(normalizedLocationId, actor, now);
      return true;
    });
  }

  function ensureActiveBranchAccountBasePermissions() {
    const accountTable = db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'portal_organization_accounts'
    `).get();
    if (!accountTable) return 0;
    db.prepare(`
      DELETE FROM portal_organization_account_permissions
      WHERE permission = 'branch_portal:display:manage'
    `).run();
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
      SELECT personnel_number AS employeeNumber, full_name AS fullName,
             COALESCE(NULLIF(TRIM(nickname), ''), full_name) AS nickname
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

  function branchPortalSettingsSnapshot(locationId) {
    ensureLocationConfiguration(locationId);
    const row = db.prepare(`
      SELECT schedule_display_mode AS scheduleDisplayMode,
             mobile_hide_elapsed_days AS mobileHideElapsedDays,
             order_autosave_enabled AS orderAutosaveEnabled,
             order_autosave_minutes AS orderAutosaveMinutes,
             updated_at AS updatedAt
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId)) || {};
    return {
      scheduleDisplayMode: row.scheduleDisplayMode === "colored" ? "colored" : "classic",
      mobileHideElapsedDays: Boolean(row.mobileHideElapsedDays),
      orderAutosaveEnabled: Boolean(row.orderAutosaveEnabled),
      orderAutosaveMinutes: Math.max(1, Math.min(99, Number(row.orderAutosaveMinutes || 10))),
      updatedAt: String(row.updatedAt || ""),
    };
  }

  function normalizedBranchPortalSettings(input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw branchOrderError("Die Filialkonto-Einstellungen sind ungültig.", "BRANCH_PORTAL_SETTINGS_INVALID");
    }
    const scheduleDisplayMode = String(input.scheduleDisplayMode || "classic").trim();
    if (!new Set(["classic", "colored"]).has(scheduleDisplayMode)) {
      throw branchOrderError("Die Dienstplanansicht ist ungültig.", "BRANCH_PORTAL_SETTINGS_INVALID");
    }
    const orderAutosaveMinutes = Number(input.orderAutosaveMinutes);
    if (!Number.isInteger(orderAutosaveMinutes) || orderAutosaveMinutes < 1 || orderAutosaveMinutes > 99) {
      throw branchOrderError("Der Speicherabstand muss eine ganze Zahl zwischen 1 und 99 Minuten sein.", "BRANCH_PORTAL_SETTINGS_INVALID");
    }
    return {
      scheduleDisplayMode,
      mobileHideElapsedDays: input.mobileHideElapsedDays === true,
      orderAutosaveEnabled: input.orderAutosaveEnabled === true,
      orderAutosaveMinutes,
    };
  }

  function saveBranchPortalSettings(locationId, input = {}, actor = "system") {
    ensureLocationConfiguration(locationId, actor);
    const settings = normalizedBranchPortalSettings(input);
    const now = new Date().toISOString();
    db.prepare(`
      UPDATE branch_order_location_settings
      SET schedule_display_mode = ?, mobile_hide_elapsed_days = ?,
          order_autosave_enabled = ?, order_autosave_minutes = ?,
          updated_at = ?, updated_by = ?
      WHERE location_id = ?
    `).run(
      settings.scheduleDisplayMode,
      settings.mobileHideElapsedDays ? 1 : 0,
      settings.orderAutosaveEnabled ? 1 : 0,
      settings.orderAutosaveMinutes,
      now, actor || "system", String(locationId),
    );
    return branchPortalSettingsSnapshot(locationId);
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
    const units = db.prepare(`
      SELECT id, title, active, sort_order AS sortOrder
      FROM branch_order_units
      WHERE location_id = ?
      ORDER BY sort_order, title COLLATE NOCASE, id
    `).all(String(locationId)).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
    }));
    const items = db.prepare(`
      SELECT item.id, item.recipient_id AS recipientId, item.unit_id AS unitId,
             unit.title AS unit, item.title, item.active, item.sort_order AS sortOrder
      FROM branch_order_catalog_items item
      JOIN branch_order_units unit ON unit.id = item.unit_id
      WHERE item.location_id = ?
      ORDER BY item.sort_order, item.title COLLATE NOCASE, item.id
    `).all(String(locationId)).map((row) => ({
      id: String(row.id),
      recipientId: String(row.recipientId || ""),
      unitId: String(row.unitId),
      unit: String(row.unit),
      title: String(row.title),
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
    }));
    const itemById = new Map(items.map((item) => [item.id, item]));
    const groups = db.prepare(`
      SELECT id, title, hint, active, sort_order AS sortOrder
      FROM branch_order_groups
      WHERE location_id = ?
      ORDER BY sort_order, title COLLATE NOCASE, id
    `).all(String(locationId)).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      hint: String(row.hint || ""),
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
      itemIds: [],
      items: [],
    }));
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const memberships = db.prepare(`
      SELECT group_id AS groupId, item_id AS itemId, sort_order AS sortOrder
      FROM branch_order_group_items
      WHERE group_id IN (SELECT id FROM branch_order_groups WHERE location_id = ?)
      ORDER BY group_id, sort_order, item_id
    `).all(String(locationId));
    for (const membership of memberships) {
      const group = groupsById.get(String(membership.groupId));
      const item = itemById.get(String(membership.itemId));
      if (!group || !item) continue;
      group.itemIds.push(item.id);
      group.items.push({ ...item, sortOrder: Number(membership.sortOrder) });
    }
    return {
      locationId: String(locationId),
      recipients,
      units,
      items,
      groups,
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
    const groups = configuration.groups
      .filter((group) => group.active)
      .map((group) => ({
        id: group.id,
        title: group.title,
        hint: group.hint,
        items: group.items
          .filter((item) => item.active)
          .map((item) => ({
            id: item.id,
            title: item.title,
            unit: item.unit,
            orderReady: Boolean(
              item.recipientId
              && configuration.recipients.some((recipient) => recipient.id === item.recipientId
                && validEmail(recipient.email) && validEmail(recipient.replyToEmail)),
            ),
          })),
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
      portalSettings: branchPortalSettingsSnapshot(locationId),
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
      SELECT DISTINCT item.id, item.title, unit.title AS unit
      FROM branch_order_catalog_items item
      JOIN branch_order_units unit ON unit.id = item.unit_id
      JOIN branch_order_group_items membership ON membership.item_id = item.id
      JOIN branch_order_groups grouping ON grouping.id = membership.group_id
      WHERE item.location_id = ? AND grouping.active = 1 AND item.active = 1
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

  function normalizeConfiguration(locationId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw branchOrderError("Die Bestellkonfiguration ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
    }
    if (!Array.isArray(input.recipients) || !Array.isArray(input.units) || !Array.isArray(input.groups)) {
      throw branchOrderError("E-Mail-Ziele, Einheiten und Gruppen müssen vollständig übermittelt werden.", "BRANCH_ORDER_CONFIGURATION_INVALID");
    }
    if (input.recipients.length > 60 || input.units.length > 80 || input.groups.length > 80) {
      throw branchOrderError("Die Bestellkonfiguration ist zu umfangreich.", "BRANCH_ORDER_CONFIGURATION_TOO_LARGE");
    }
    const idsForLocation = (table) => new Set(db.prepare(`
      SELECT id FROM ${table} WHERE location_id = ?
    `).all(String(locationId)).map((row) => String(row.id)));
    const existingRecipientIds = idsForLocation("branch_order_recipients");
    const existingUnitIds = idsForLocation("branch_order_units");
    const existingItemIds = idsForLocation("branch_order_catalog_items");
    const existingGroupIds = idsForLocation("branch_order_groups");
    const retainedOrNewId = (reference, existingIds) => (
      existingIds.has(reference) ? reference : crypto.randomUUID()
    );
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
        id: retainedOrNewId(reference, existingRecipientIds),
        email,
        replyToEmail,
        subjectTemplate: normalizedTemplate(source.subjectTemplate, { subject: true }),
        bodyTemplate: normalizedTemplate(source.bodyTemplate),
      };
      recipientIdByReference.set(reference, recipient.id);
      return recipient;
    });

    const seenUnitRefs = new Set();
    const seenUnitTitles = new Set();
    const unitIdByReference = new Map();
    const units = input.units.map((source, index) => {
      const reference = safeClientReference(typeof source === "object" ? source?.id : source, `unit-${index + 1}`);
      if (seenUnitRefs.has(reference)) {
        throw branchOrderError("Einheiten dürfen nicht doppelt vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      seenUnitRefs.add(reference);
      const title = textValue(typeof source === "object" ? source?.title : source, {
        label: "Die Einheit", minimum: 1, maximum: 40,
      });
      const titleKey = title.toLocaleLowerCase("de-AT");
      if (seenUnitTitles.has(titleKey)) {
        throw branchOrderError("Eine Maßeinheit darf nur einmal vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      seenUnitTitles.add(titleKey);
      const unit = { id: retainedOrNewId(reference, existingUnitIds), title };
      unitIdByReference.set(reference, unit.id);
      unitIdByReference.set(`title:${titleKey}`, unit.id);
      return unit;
    });
    const sourceItems = Array.isArray(input.items) ? [...input.items] : [];
    for (const group of input.groups) {
      if (group && typeof group === "object" && Array.isArray(group.items)) sourceItems.push(...group.items);
    }
    if (sourceItems.length > 400) {
      throw branchOrderError("Der Positionskatalog ist zu umfangreich.", "BRANCH_ORDER_CONFIGURATION_TOO_LARGE");
    }
    const seenItemRefs = new Set();
    const itemIdByReference = new Map();
    const items = [];
    for (const [index, source] of sourceItems.entries()) {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw branchOrderError("Eine Bestellposition ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      const reference = safeClientReference(source.id, `item-${index + 1}`);
      if (seenItemRefs.has(reference)) continue;
      seenItemRefs.add(reference);
      const recipientReference = String(source.recipientId || "").trim();
      const recipientId = recipientReference ? recipientIdByReference.get(recipientReference) : null;
      if (recipientReference && !recipientId) {
        throw branchOrderError("Eine Position verweist auf ein unbekanntes E-Mail-Ziel.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      const suppliedUnitReference = String(source.unitId || "").trim();
      const unitReference = suppliedUnitReference || `title:${String(source.unit || "").trim().toLocaleLowerCase("de-AT")}`;
      const unitId = unitIdByReference.get(unitReference);
      if (!unitId) {
        throw branchOrderError("Eine Position verweist auf eine unbekannte Einheit.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      const item = {
        id: retainedOrNewId(reference, existingItemIds),
        recipientId: recipientId || null,
        unitId,
        title: textValue(source.title, { label: "Die Bestellposition", minimum: 2, maximum: 180 }),
      };
      itemIdByReference.set(reference, item.id);
      items.push(item);
    }
    const seenGroupRefs = new Set();
    const groups = input.groups.map((source, index) => {
      if (!source || typeof source !== "object" || Array.isArray(source)) {
        throw branchOrderError("Eine Warengruppe ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      const references = Array.isArray(source.itemIds)
        ? source.itemIds
        : Array.isArray(source.items) ? source.items.map((item, itemIndex) => item?.id || `item-${itemIndex + 1}`) : [];
      if (references.length > 160) {
        throw branchOrderError("Eine Warengruppe enthält zu viele Positionen.", "BRANCH_ORDER_CONFIGURATION_TOO_LARGE");
      }
      const reference = safeClientReference(source.id, `group-${index + 1}`);
      if (seenGroupRefs.has(reference)) {
        throw branchOrderError("Warengruppen dürfen nicht doppelt vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      seenGroupRefs.add(reference);
      const seenGroupItems = new Set();
      const itemIds = references.map((itemReference, itemIndex) => {
        const safeReference = safeClientReference(itemReference, `item-${itemIndex + 1}`);
        if (seenGroupItems.has(safeReference)) {
          throw branchOrderError("Eine Position darf innerhalb einer Gruppe nur einmal vorkommen.", "BRANCH_ORDER_CONFIGURATION_INVALID");
        }
        seenGroupItems.add(safeReference);
        const itemId = itemIdByReference.get(safeReference);
        if (!itemId) {
          throw branchOrderError("Eine Gruppe verweist auf eine unbekannte Position.", "BRANCH_ORDER_CONFIGURATION_INVALID");
        }
        return itemId;
      });
      return {
        id: retainedOrNewId(reference, existingGroupIds),
        title: textValue(source.title, { label: "Die Warengruppe", minimum: 2, maximum: 120 }),
        hint: textValue(source.hint, { label: "Der Hinweis", maximum: 400 }),
        itemIds,
      };
    });
    return { recipients, units, items, groups };
  }

  function replaceConfiguration(locationId, input, actor = "") {
    ensureLocationConfiguration(locationId, actor || "system");
    const normalized = normalizeConfiguration(locationId, input);
    const now = new Date().toISOString();
    transaction(() => {
      db.prepare(`
        DELETE FROM branch_order_group_items
        WHERE group_id IN (SELECT id FROM branch_order_groups WHERE location_id = ?)
      `).run(String(locationId));
      db.prepare("DELETE FROM branch_order_catalog_items WHERE location_id = ?").run(String(locationId));
      db.prepare("DELETE FROM branch_order_groups WHERE location_id = ?").run(String(locationId));
      db.prepare("DELETE FROM branch_order_units WHERE location_id = ?").run(String(locationId));
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
      for (const [unitIndex, unit] of normalized.units.entries()) {
        db.prepare(`
          INSERT INTO branch_order_units
            (id, location_id, title, active, sort_order, created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(unit.id, String(locationId), unit.title, unitIndex + 1, now, actor, now, actor);
      }
      for (const [groupIndex, group] of normalized.groups.entries()) {
        db.prepare(`
          INSERT INTO branch_order_groups
            (id, location_id, recipient_id, title, hint, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          group.id, String(locationId), group.title, group.hint,
          groupIndex + 1, now, actor, now, actor,
        );
      }
      for (const [itemIndex, item] of normalized.items.entries()) {
        db.prepare(`
          INSERT INTO branch_order_catalog_items
            (id, location_id, recipient_id, unit_id, title, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          item.id, String(locationId), item.recipientId, item.unitId, item.title,
          itemIndex + 1, now, actor, now, actor,
        );
      }
      for (const group of normalized.groups) {
        for (const [itemIndex, itemId] of group.itemIds.entries()) {
          db.prepare(`
            INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
            VALUES (?, ?, ?)
          `).run(group.id, itemId, itemIndex + 1);
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
        if (!activeItems.has(item.id)) {
          activeItems.set(item.id, {
            group,
            item,
            recipient: recipientsById.get(item.recipientId) || null,
          });
        }
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
          `Für die Position „${configured.item.title}“ fehlt ein vollständiges E-Mail-Ziel mit Antwortadresse.`,
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
        employeeNickname: employee.nickname,
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
    if (!["pending", "sent", "failed"].includes(status)) {
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
      status === "sent" ? "" : textValue(failureCode, { label: "Der Versandhinweis", maximum: 120 }),
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
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount
      FROM branch_order_deliveries
      WHERE order_id = ?
    `).get(String(orderId));
    const count = Number(aggregate?.count || 0);
    const sentCount = Number(aggregate?.sentCount || 0);
    const pendingCount = Number(aggregate?.pendingCount || 0);
    const status = pendingCount > 0
      ? "pending"
      : count > 0 && sentCount === count
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
      pending: pendingCount,
    };
  }

  function confirmOrderDeliveries(locationId, orderId, confirmedAt = new Date().toISOString()) {
    const order = db.prepare(`
      SELECT id FROM branch_orders WHERE id = ? AND location_id = ?
    `).get(String(orderId), String(locationId));
    if (!order) {
      throw branchOrderError("Die Bestellung wurde für diesen Standort nicht gefunden.", "BRANCH_ORDER_NOT_FOUND", 404);
    }
    const result = db.prepare(`
      UPDATE branch_order_deliveries
      SET status = 'sent', failure_code = '', attempted_at = COALESCE(attempted_at, ?),
          sent_at = COALESCE(sent_at, ?), updated_at = ?
      WHERE order_id = ? AND status IN ('pending', 'failed')
    `).run(confirmedAt, confirmedAt, confirmedAt, String(orderId));
    return {
      changed: Number(result.changes || 0),
      ...finalizeOrder(orderId, confirmedAt),
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
    branchPortalSettingsSnapshot,
    catalogSnapshot,
    createOrder,
    deleteDraft,
    draftSnapshot,
    ensureActiveBranchAccountBasePermissions,
    ensureLocationConfiguration,
    finalizeOrder,
    confirmOrderDeliveries,
    history,
    markDelivery,
    orderPdf,
    replaceConfiguration,
    saveBranchPortalSettings,
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
