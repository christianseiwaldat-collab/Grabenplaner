// Explicit asynchronous PostgreSQL port. SQLite baseline SHA-256: 73290ba8b0ef0fbc8201339f6cb9826fc19f5570fbff3d926d383e2da29356bb
"use strict";
const asyncCollections = require("./async-collections");

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
const BRANCH_ORDER_DELIVERY_MODES = new Set(["message", "message_pdf", "pdf_only"]);
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

const BRANCH_ORDER_CATALOG_CONTENT_VERSION = 1;
const PLOTTER_PAPER_CATALOG_ITEMS = Object.freeze([
  Object.freeze({ title: "Papierrolle – Photorag Ultra Smooth", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Hemp", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – German Etching", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Photo Rag Baryta", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – FineArt Baryta", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Photo Glossy", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Premium Canvas Satin", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Photo Luster", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Goya Canvas", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "Papierrolle – Metallic", unit: "Rolle", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – Photo Rag Bright White 310 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – Photo Rag Metallic 340 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – German Etching 310 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – Photo Rag Baryta 315 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – Photo Rag Ultra Smooth 305 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – Hemp 290 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A4 – Fine Art Baryta 325 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – Fine Art Baryta 325 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – Photo Rag Metallic 340 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – Hemp 290 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – Photo Rag Baryta 315 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – German Etching 310 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – Photo Rag Ultra Smooth 305 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A3+ – Photo Rag Bright White 310 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A2 – German Etching 310 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A2 – Hemp 290 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A2 – Photo Rag Bright White 310 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A2 – Photo Rag Ultra Smooth 305 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A2 – Fine Art Baryta 325 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
  Object.freeze({ title: "DIN A2 – Photo Rag Metallic 340 gsm", unit: "Packung", recipient: "lager", groups: ["plotter"] }),
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
  ...PLOTTER_PAPER_CATALOG_ITEMS,
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
  if (!database || typeof database.transaction !== "function" || typeof database.prepare !== "function") {
    throw new TypeError("Ein asynchroner PostgreSQL-Operationszugriff wird benötigt.");
  }
  return database;
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

function normalizedOptionalEmail(value, label) {
  const email = String(value || "").trim().toLowerCase();
  return email ? normalizedEmail(email, label) : "";
}

function normalizedDeliveryMode(value, label) {
  const mode = String(value || "message").trim().toLowerCase();
  if (!BRANCH_ORDER_DELIVERY_MODES.has(mode)) {
    throw branchOrderError(
      `${label || "Die Versandart"} ist ungültig.`,
      "BRANCH_ORDER_DELIVERY_MODE_INVALID",
    );
  }
  return mode;
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

function createPostgresqlBranchOrderOperations(database) {
  const db = assertDatabase(database);

  async function transaction(work) { return db.transaction(work); }

  async function hasLocationSettings(locationId) {
    return Boolean((await db.prepare(`
      SELECT 1
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId))));
  }

  async function insertUnit(locationId, title, sortOrder, now, actor) {
    const id = crypto.randomUUID();
    (await db.prepare(`
      INSERT INTO branch_order_units
        (id, location_id, title, active, sort_order, created_at, created_by, updated_at, updated_by)
      VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
    `).run(id, locationId, title, sortOrder, now, actor, now, actor));
    return id;
  }

  async function seedDefaultCatalog(locationId, actor, now) {
    const recipientIds = new Map();
    for (const recipient of DEFAULT_BRANCH_ORDER_RECIPIENTS) {
      const id = crypto.randomUUID();
      recipientIds.set(recipient.key, id);
      (await db.prepare(`
        INSERT INTO branch_order_recipients
          (id, location_id, email, reply_to_email, subject_template, body_template,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id, locationId, recipient.email, recipient.email,
        DEFAULT_SUBJECT_TEMPLATE, DEFAULT_BODY_TEMPLATE, now, actor, now, actor,
      ));
    }
    const unitIds = new Map();
    (await asyncCollections.forEach(DEFAULT_BRANCH_ORDER_UNITS, async (unit, index) => unitIds.set(
      unit,
      (await insertUnit(locationId, unit, index + 1, now, actor)),
    )));
    const groupIds = new Map();
    (await asyncCollections.forEach(DEFAULT_BRANCH_ORDER_GROUPS, async (group, index) => {
      const id = crypto.randomUUID();
      groupIds.set(group.key, id);
      (await db.prepare(`
        INSERT INTO branch_order_groups
          (id, location_id, recipient_id, title, hint, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(id, locationId, group.title, group.hint, index + 1, now, actor, now, actor));
    }));
    const groupSort = new Map();
    for (const item of DEFAULT_BRANCH_ORDER_ITEMS) {
      const itemId = crypto.randomUUID();
      (await db.prepare(`
        INSERT INTO branch_order_catalog_items
          (id, location_id, recipient_id, unit_id, title, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(
        itemId, locationId, recipientIds.get(item.recipient) || null, unitIds.get(item.unit),
        item.title, DEFAULT_BRANCH_ORDER_ITEMS.indexOf(item) + 1, now, actor, now, actor,
      ));
      for (const groupKey of item.groups) {
        const groupId = groupIds.get(groupKey);
        const nextSort = Number(groupSort.get(groupId) || 0) + 1;
        groupSort.set(groupId, nextSort);
        (await db.prepare(`
          INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
          VALUES (?, ?, ?)
        `).run(groupId, itemId, nextSort));
      }
    }
    (await db.prepare(`
      UPDATE branch_order_location_settings
      SET catalog_content_version = ?
      WHERE location_id = ?
    `).run(BRANCH_ORDER_CATALOG_CONTENT_VERSION, String(locationId)));
  }

  async function ensureCurrentCatalogContent(locationId, actor = "system") {
    const version = Number((await db.prepare(`
      SELECT catalog_content_version AS version
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId)))?.version || 0);
    if (version >= BRANCH_ORDER_CATALOG_CONTENT_VERSION) return false;
    return (await transaction(async () => {
      const currentVersion = Number((await db.prepare(`
        SELECT catalog_content_version AS version
        FROM branch_order_location_settings
        WHERE location_id = ?
      `).get(String(locationId)))?.version || 0);
      if (currentVersion >= BRANCH_ORDER_CATALOG_CONTENT_VERSION) return false;
      const now = new Date().toISOString();
      const plotterDefinition = DEFAULT_BRANCH_ORDER_GROUPS.find((group) => group.key === "plotter");
      let plotterGroup = (await db.prepare(`
        SELECT id
        FROM branch_order_groups
        WHERE location_id = ? AND active = 1 AND title = ? COLLATE NOCASE
        ORDER BY sort_order, id
        LIMIT 1
      `).get(String(locationId), plotterDefinition.title));
      if (!plotterGroup) {
        plotterGroup = (await db.prepare(`
          SELECT grouping.id
          FROM branch_order_groups grouping
          JOIN branch_order_group_items membership ON membership.group_id = grouping.id
          JOIN branch_order_catalog_items item ON item.id = membership.item_id
          WHERE grouping.location_id = ? AND grouping.active = 1
            AND item.title IN ('Plotterpapier', 'Plottertinten Canon', 'Plotter-Wartungsbehälter', 'Plotter: Sonstiges')
          GROUP BY grouping.id
          ORDER BY COUNT(*) DESC, grouping.sort_order, grouping.id
          LIMIT 1
        `).get(String(locationId)));
      }
      let changed = false;
      if (!plotterGroup) {
        const groupId = crypto.randomUUID();
        const sortOrder = Number((await db.prepare(`
          SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSort
          FROM branch_order_groups
          WHERE location_id = ?
        `).get(String(locationId)))?.nextSort || 1);
        (await db.prepare(`
          INSERT INTO branch_order_groups
            (id, location_id, recipient_id, title, hint, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          groupId, String(locationId), plotterDefinition.title, plotterDefinition.hint,
          sortOrder, now, actor, now, actor,
        ));
        plotterGroup = { id: groupId };
        changed = true;
      }
      const unitIds = new Map();
      for (const title of ["Rolle", "Packung"]) {
        let unit = (await db.prepare(`
          SELECT id
          FROM branch_order_units
          WHERE location_id = ? AND title = ? COLLATE NOCASE
          ORDER BY active DESC, sort_order, id
          LIMIT 1
        `).get(String(locationId), title));
        if (!unit) {
          const sortOrder = Number((await db.prepare(`
            SELECT COALESCE(MAX(sort_order), 0) + 1 AS nextSort
            FROM branch_order_units
            WHERE location_id = ?
          `).get(String(locationId)))?.nextSort || 1);
          unit = { id: (await insertUnit(String(locationId), title, sortOrder, now, actor)) };
          changed = true;
        }
        unitIds.set(title, unit.id);
      }
      const groupRecipient = (await db.prepare(`
        SELECT item.recipient_id AS id
        FROM branch_order_group_items membership
        JOIN branch_order_catalog_items item ON item.id = membership.item_id
        WHERE membership.group_id = ? AND item.active = 1 AND item.recipient_id IS NOT NULL
        GROUP BY item.recipient_id
        ORDER BY COUNT(*) DESC, MIN(membership.sort_order), item.recipient_id
        LIMIT 1
      `).get(plotterGroup.id)) || (await db.prepare(`
        SELECT id
        FROM branch_order_recipients
        WHERE location_id = ? AND email = 'lager@lamprechter.com' COLLATE NOCASE
        ORDER BY id
        LIMIT 1
      `).get(String(locationId)));
      const catalogItems = (await db.prepare(`
        SELECT id, title
        FROM branch_order_catalog_items
        WHERE location_id = ?
      `).all(String(locationId)));
      const catalogByTitle = new Map(catalogItems.map((item) => [
        String(item.title || "").trim().toLocaleLowerCase("de-AT"),
        item,
      ]));
      let catalogSort = Number((await db.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM branch_order_catalog_items
        WHERE location_id = ?
      `).get(String(locationId)))?.maximum || 0);
      let groupSort = Number((await db.prepare(`
        SELECT COALESCE(MAX(sort_order), 0) AS maximum
        FROM branch_order_group_items
        WHERE group_id = ?
      `).get(plotterGroup.id))?.maximum || 0);
      for (const definition of PLOTTER_PAPER_CATALOG_ITEMS) {
        const titleKey = definition.title.toLocaleLowerCase("de-AT");
        let catalogItem = catalogByTitle.get(titleKey);
        if (!catalogItem) {
          catalogItem = { id: crypto.randomUUID(), title: definition.title };
          catalogSort += 1;
          (await db.prepare(`
            INSERT INTO branch_order_catalog_items
              (id, location_id, recipient_id, unit_id, title, active, sort_order,
               created_at, created_by, updated_at, updated_by)
            VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
          `).run(
            catalogItem.id, String(locationId), groupRecipient?.id || null,
            unitIds.get(definition.unit), definition.title, catalogSort,
            now, actor, now, actor,
          ));
          catalogByTitle.set(titleKey, catalogItem);
          changed = true;
        }
        const membership = (await db.prepare(`
          SELECT 1
          FROM branch_order_group_items
          WHERE group_id = ? AND item_id = ?
        `).get(plotterGroup.id, catalogItem.id));
        if (!membership) {
          groupSort += 1;
          (await db.prepare(`
            INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
            VALUES (?, ?, ?)
          `).run(plotterGroup.id, catalogItem.id, groupSort));
          changed = true;
        }
      }
      (await db.prepare(`
        UPDATE branch_order_location_settings
        SET catalog_content_version = ?, updated_at = ?, updated_by = ?
        WHERE location_id = ?
      `).run(BRANCH_ORDER_CATALOG_CONTENT_VERSION, now, actor, String(locationId)));
      return changed;
    }));
  }

  async function legacyCatalogRows(locationId) {
    return (await db.prepare(`
      SELECT grouping.id AS groupId, grouping.recipient_id AS recipientId,
             grouping.title AS groupTitle, grouping.hint AS groupHint,
             grouping.active AS groupActive, grouping.sort_order AS groupSortOrder,
             item.id AS itemId, item.title AS itemTitle, item.unit AS unit,
             item.active AS itemActive, item.sort_order AS itemSortOrder
      FROM branch_order_groups grouping
      JOIN branch_order_items item ON item.group_id = grouping.id
      WHERE grouping.location_id = ?
      ORDER BY grouping.sort_order, item.sort_order, item.id
    `).all(locationId));
  }

  async function migrateLegacyCatalog(locationId, actor, now) {
    const rows = (await legacyCatalogRows(locationId));
    if (!rows.length) {
      (await seedDefaultCatalog(locationId, actor, now));
      return;
    }
    const unitIds = new Map();
    const unitTitles = [...new Set([...DEFAULT_BRANCH_ORDER_UNITS, ...rows.map((row) => String(row.unit))])];
    (await asyncCollections.forEach(unitTitles, async (unit, index) => unitIds.set(unit, (await insertUnit(locationId, unit, index + 1, now, actor)))));
    const itemRows = new Map();
    for (const row of rows) {
      if (itemRows.has(String(row.itemId))) continue;
      (await db.prepare(`
        INSERT INTO branch_order_catalog_items
          (id, location_id, recipient_id, unit_id, title, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        row.itemId, locationId, row.recipientId || null, unitIds.get(String(row.unit)),
        row.itemTitle, Number(row.itemActive) ? 1 : 0, Number(row.itemSortOrder), now, actor, now, actor,
      ));
      itemRows.set(String(row.itemId), row);
    }
    const legacyGroups = [...new Map(rows.map((row) => [String(row.groupId), row])).values()];
    const legacyTitles = new Set(legacyGroups.map((row) => String(row.groupTitle)));
    const isOldDefault = legacyTitles.size === 3
      && ["Lager", "Marketing", "Sonstiges"].every((title) => legacyTitles.has(title));
    if (!isOldDefault) {
      for (const row of rows) {
        (await db.prepare(`
          INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
          VALUES (?, ?, ?)
        `).run(row.groupId, row.itemId, Number(row.itemSortOrder)));
      }
      return;
    }
    const recipientIdByKey = new Map();
    const recipients = (await db.prepare(`SELECT id, email FROM branch_order_recipients WHERE location_id = ?`).all(locationId));
    for (const defaultRecipient of DEFAULT_BRANCH_ORDER_RECIPIENTS) {
      const matched = recipients.find((recipient) => String(recipient.email).toLowerCase() === defaultRecipient.email);
      if (matched) recipientIdByKey.set(defaultRecipient.key, matched.id);
    }
    const legacyWarehouseRecipient = legacyGroups.find((row) => row.groupTitle === "Lager")?.recipientId || null;
    const legacyMarketingRecipient = legacyGroups.find((row) => row.groupTitle === "Marketing")?.recipientId || null;
    const byTitle = new Map([...itemRows.values()].map((row) => [String(row.itemTitle), row]));
    const groupIds = new Map();
    (await asyncCollections.forEach(DEFAULT_BRANCH_ORDER_GROUPS, async (group, index) => {
      const id = crypto.randomUUID();
      groupIds.set(group.key, id);
      (await db.prepare(`
        INSERT INTO branch_order_groups
          (id, location_id, recipient_id, title, hint, active, sort_order,
           created_at, created_by, updated_at, updated_by)
        VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
      `).run(id, locationId, group.title, group.hint, index + 1, now, actor, now, actor));
    }));
    const groupSort = new Map();
    const assignedLegacyItemIds = new Set();
    for (const definition of DEFAULT_BRANCH_ORDER_ITEMS) {
      let source = byTitle.get(definition.title);
      let itemId = source?.itemId;
      if (!source) {
        itemId = crypto.randomUUID();
        (await db.prepare(`
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
        ));
      } else {
        assignedLegacyItemIds.add(String(itemId));
        (await db.prepare(`
          UPDATE branch_order_catalog_items
          SET recipient_id = COALESCE(?, recipient_id), unit_id = ?, updated_at = ?, updated_by = ?
          WHERE id = ? AND location_id = ?
        `).run(
          recipientIdByKey.get(definition.recipient)
            || (definition.recipient === "marketing" ? legacyMarketingRecipient : legacyWarehouseRecipient),
          unitIds.get(String(source.unit)) || unitIds.get(definition.unit), now, actor, itemId, locationId,
        ));
      }
      for (const groupKey of definition.groups) {
        const groupId = groupIds.get(groupKey);
        const sortOrder = Number(groupSort.get(groupId) || 0) + 1;
        groupSort.set(groupId, sortOrder);
        (await db.prepare(`INSERT INTO branch_order_group_items (group_id, item_id, sort_order) VALUES (?, ?, ?)`)
          .run(groupId, itemId, sortOrder));
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
      (await db.prepare(`INSERT INTO branch_order_group_items (group_id, item_id, sort_order) VALUES (?, ?, ?)`)
        .run(groupId, source.itemId, sortOrder));
    }
    (await db.prepare(`DELETE FROM branch_order_groups WHERE location_id = ? AND id IN (${legacyGroups.map(() => "?").join(",")})`)
      .run(locationId, ...legacyGroups.map((row) => row.groupId)));
  }

  async function ensureCatalogConfiguration(locationId, actor = "system") {
    const count = Number((await db.prepare(`
      SELECT COUNT(*) AS count FROM branch_order_catalog_items WHERE location_id = ?
    `).get(locationId))?.count || 0);
    if (count) return false;
    return (await transaction(async () => {
      const existing = Number((await db.prepare(`
        SELECT COUNT(*) AS count FROM branch_order_catalog_items WHERE location_id = ?
      `).get(locationId))?.count || 0);
      if (existing) return false;
      const now = new Date().toISOString();
      (await migrateLegacyCatalog(locationId, actor, now));
      (await db.prepare(`
        UPDATE branch_order_location_settings SET updated_at = ?, updated_by = ? WHERE location_id = ?
      `).run(now, actor, locationId));
      return true;
    }));
  }

  async function ensureLocationConfiguration(locationId, actor = "system") {
    const normalizedLocationId = String(locationId || "").trim();
    if (!normalizedLocationId) throw branchOrderError("Die Filiale fehlt.", "BRANCH_ORDER_LOCATION_REQUIRED");
    if ((await hasLocationSettings(normalizedLocationId))) {
      (await ensureCatalogConfiguration(normalizedLocationId, actor));
      (await ensureCurrentCatalogContent(normalizedLocationId, actor));
      return false;
    }
    return (await transaction(async () => {
      if ((await hasLocationSettings(normalizedLocationId))) return false;
      const now = new Date().toISOString();
      (await db.prepare(`
        INSERT INTO branch_order_location_settings
          (location_id, initialized_at, initialized_by, updated_at, updated_by)
        VALUES (?, ?, ?, ?, ?)
      `).run(normalizedLocationId, now, actor, now, actor));
      (await seedDefaultCatalog(normalizedLocationId, actor, now));
      return true;
    }));
  }

  async function ensureConfiguredLocationCatalogContent(actor = "system:branch-order-catalog-startup") {
    const locations = (await db.prepare(`
      SELECT location_id AS locationId, catalog_content_version AS catalogContentVersion
      FROM branch_order_location_settings
      ORDER BY location_id
    `).all());
    let upgraded = 0;
    for (const location of locations) {
      const locationId = String(location.locationId);
      const previousVersion = Number(location.catalogContentVersion || 0);
      (await ensureCatalogConfiguration(locationId, actor));
      (await ensureCurrentCatalogContent(locationId, actor));
      const currentVersion = Number((await db.prepare(`
        SELECT catalog_content_version AS version
        FROM branch_order_location_settings
        WHERE location_id = ?
      `).get(locationId))?.version || 0);
      if (previousVersion < BRANCH_ORDER_CATALOG_CONTENT_VERSION
        && currentVersion >= BRANCH_ORDER_CATALOG_CONTENT_VERSION) upgraded += 1;
    }
    return upgraded;
  }

  async function ensureActiveBranchAccountBasePermissions() {
    const accountTable = (await db.prepare(`
      SELECT 1 FROM sqlite_master
      WHERE type = 'table' AND name = 'portal_organization_accounts'
    `).get());
    if (!accountTable) return 0;
    (await db.prepare(`
      DELETE FROM portal_organization_account_permissions
      WHERE permission = 'branch_portal:display:manage'
    `).run());
    const result = (await db.prepare(`
      INSERT OR IGNORE INTO portal_organization_account_permissions
        (account_id, permission, granted_by, updated_at)
      SELECT account.id, required.permission, 'system:branch-account-base', CURRENT_TIMESTAMP
      FROM portal_organization_accounts account
      CROSS JOIN (
        SELECT 'loans:overview:read' AS permission
        UNION ALL SELECT 'schedule:location:view'
      ) required
      WHERE account.account_type = 'branch' AND account.active = 1
    `).run());
    return Number(result.changes || 0);
  }

  async function locationRow(locationId) {
    return (await db.prepare(`
      SELECT id, name
      FROM locations
      WHERE id = ? AND active = 1
    `).get(String(locationId)));
  }

  async function activeEmployeeRow(locationId, employeeNumber) {
    return (await db.prepare(`
      SELECT personnel_number AS employeeNumber, full_name AS fullName,
             COALESCE(NULLIF(TRIM(nickname), ''), full_name) AS nickname
      FROM employees
      WHERE personnel_number = ? AND home_location_id = ? AND active = 1
    `).get(String(employeeNumber), String(locationId)));
  }

  async function configurationUpdatedAt(locationId) {
    (await ensureLocationConfiguration(locationId));
    return String((await db.prepare(`
      SELECT updated_at AS updatedAt
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId)))?.updatedAt || "");
  }

  async function branchPortalSettingsSnapshot(locationId) {
    (await ensureLocationConfiguration(locationId));
    const row = (await db.prepare(`
      SELECT schedule_display_mode AS scheduleDisplayMode,
             mobile_hide_elapsed_days AS mobileHideElapsedDays,
             order_autosave_enabled AS orderAutosaveEnabled,
             order_autosave_minutes AS orderAutosaveMinutes,
             updated_at AS updatedAt
      FROM branch_order_location_settings
      WHERE location_id = ?
    `).get(String(locationId))) || {};
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

  async function saveBranchPortalSettings(locationId, input = {}, actor = "system") {
    (await ensureLocationConfiguration(locationId, actor));
    const settings = normalizedBranchPortalSettings(input);
    const now = new Date().toISOString();
    (await db.prepare(`
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
    ));
    return (await branchPortalSettingsSnapshot(locationId));
  }

  async function settingsSnapshot(locationId) {
    (await ensureLocationConfiguration(locationId));
    const recipients = (await db.prepare(`
      SELECT id, email, cc_email AS ccEmail,
             primary_delivery_mode AS primaryDeliveryMode,
             cc_delivery_mode AS ccDeliveryMode,
             reply_to_email AS replyToEmail,
             subject_template AS subjectTemplate, body_template AS bodyTemplate
      FROM branch_order_recipients
      WHERE location_id = ?
      ORDER BY email COLLATE NOCASE, id
    `).all(String(locationId))).map((row) => ({
      id: row.id,
      email: row.email,
      ccEmail: validEmail(row.ccEmail) && String(row.ccEmail).toLowerCase() !== String(row.email).toLowerCase()
        ? row.ccEmail
        : "",
      primaryDeliveryMode: BRANCH_ORDER_DELIVERY_MODES.has(row.primaryDeliveryMode)
        ? row.primaryDeliveryMode
        : "message",
      ccDeliveryMode: BRANCH_ORDER_DELIVERY_MODES.has(row.ccDeliveryMode)
        ? row.ccDeliveryMode
        : "message",
      replyToEmail: validEmail(row.replyToEmail) ? row.replyToEmail : row.email,
      subjectTemplate: row.subjectTemplate,
      bodyTemplate: row.bodyTemplate,
    }));
    const units = (await db.prepare(`
      SELECT id, title, active, sort_order AS sortOrder
      FROM branch_order_units
      WHERE location_id = ?
      ORDER BY sort_order, title COLLATE NOCASE, id
    `).all(String(locationId))).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
    }));
    const items = (await db.prepare(`
      SELECT item.id, item.recipient_id AS recipientId, item.unit_id AS unitId,
             unit.title AS unit, item.title, item.active, item.sort_order AS sortOrder
      FROM branch_order_catalog_items item
      JOIN branch_order_units unit ON unit.id = item.unit_id
      WHERE item.location_id = ?
      ORDER BY item.sort_order, item.title COLLATE NOCASE, item.id
    `).all(String(locationId))).map((row) => ({
      id: String(row.id),
      recipientId: String(row.recipientId || ""),
      unitId: String(row.unitId),
      unit: String(row.unit),
      title: String(row.title),
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
    }));
    const itemById = new Map(items.map((item) => [item.id, item]));
    const groups = (await db.prepare(`
      SELECT id, title, hint, active, sort_order AS sortOrder
      FROM branch_order_groups
      WHERE location_id = ?
      ORDER BY sort_order, title COLLATE NOCASE, id
    `).all(String(locationId))).map((row) => ({
      id: String(row.id),
      title: String(row.title),
      hint: String(row.hint || ""),
      active: Boolean(row.active),
      sortOrder: Number(row.sortOrder),
      itemIds: [],
      items: [],
    }));
    const groupsById = new Map(groups.map((group) => [group.id, group]));
    const memberships = (await db.prepare(`
      SELECT group_id AS groupId, item_id AS itemId, sort_order AS sortOrder
      FROM branch_order_group_items
      WHERE group_id IN (SELECT id FROM branch_order_groups WHERE location_id = ?)
      ORDER BY group_id, sort_order, item_id
    `).all(String(locationId)));
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

  async function catalogSnapshot(locationId) {
    const location = (await locationRow(locationId));
    if (!location) throw branchOrderError("Die Filiale ist nicht aktiv.", "BRANCH_ORDER_LOCATION_INVALID", 404);
    const configuration = (await settingsSnapshot(locationId));
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
    const employees = (await db.prepare(`
      SELECT personnel_number AS employeeNumber, full_name AS fullName
      FROM employees
      WHERE active = 1 AND home_location_id = ?
      ORDER BY full_name COLLATE NOCASE, personnel_number COLLATE NOCASE
    `).all(String(locationId))).map((row) => ({
      employeeNumber: String(row.employeeNumber),
      fullName: String(row.fullName),
    }));
    return {
      location: { id: String(location.id), name: String(location.name) },
      groups,
      employees,
      configurationUpdatedAt: (await configurationUpdatedAt(locationId)),
      portalSettings: (await branchPortalSettingsSnapshot(locationId)),
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

  async function activeDraftItems(locationId) {
    return new Map((await db.prepare(`
      SELECT DISTINCT item.id, item.title, unit.title AS unit
      FROM branch_order_catalog_items item
      JOIN branch_order_units unit ON unit.id = item.unit_id
      JOIN branch_order_group_items membership ON membership.item_id = item.id
      JOIN branch_order_groups grouping ON grouping.id = membership.group_id
      WHERE item.location_id = ? AND grouping.active = 1 AND item.active = 1
    `).all(String(locationId))).map((item) => [String(item.id), {
      id: String(item.id),
      title: String(item.title),
      unit: String(item.unit),
    }]));
  }

  async function preparedDraft(locationId, input = {}) {
    const location = (await locationRow(locationId));
    if (!location) throw branchOrderError("Die Filiale ist nicht aktiv.", "BRANCH_ORDER_LOCATION_INVALID", 404);
    (await ensureLocationConfiguration(locationId));
    const scope = normalizedDraftScope(input);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    const employee = (await activeEmployeeRow(locationId, employeeNumber));
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
    const availableItems = (await activeDraftItems(locationId));
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
      configurationUpdatedAt: (await configurationUpdatedAt(locationId)),
      expectedRevision: normalizedDraftRevision(input.expectedRevision),
      lines,
    };
  }

  async function draftSnapshot(locationId, input = {}) {
    const scope = normalizedDraftScope(input);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    if (!(await activeEmployeeRow(locationId, employeeNumber))) return null;
    const row = (await db.prepare(`
      SELECT id, location_id AS locationId, owner_kind AS ownerKind,
             selected_employee_number AS selectedEmployeeNumber,
             selected_employee_name AS selectedEmployeeName,
             week_start_at_save AS weekStartAtSave,
             configuration_updated_at AS configurationUpdatedAt,
             revision, created_at AS createdAt, updated_at AS updatedAt
      FROM branch_order_drafts
      WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
    `).get(String(locationId), scope.ownerAccountId, employeeNumber));
    if (!row) return null;
    const availableItems = (await activeDraftItems(locationId));
    const currentConfigurationUpdatedAt = (await configurationUpdatedAt(locationId));
    const items = (await db.prepare(`
      SELECT item_id AS itemId, item_title_snapshot AS itemTitle,
             unit_snapshot AS unit, quantity, note, sort_order AS sortOrder
      FROM branch_order_draft_lines
      WHERE draft_id = ?
      ORDER BY sort_order, item_id
    `).all(String(row.id))).map((line) => {
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

  async function saveDraft(locationId, input = {}) {
    const draft = (await preparedDraft(locationId, input));
    (await transaction(async () => {
      const existing = (await db.prepare(`
        SELECT id, revision
        FROM branch_order_drafts
        WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
      `).get(draft.locationId, draft.ownerAccountId, draft.employee.employeeNumber));
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
        (await db.prepare(`
          UPDATE branch_order_drafts
          SET owner_kind = ?, selected_employee_name = ?, week_start_at_save = ?,
              configuration_updated_at = ?, revision = ?, updated_at = ?, updated_by_login = ?
          WHERE id = ?
        `).run(
          draft.ownerKind, draft.employee.fullName, draft.weekStartAtSave,
          draft.configurationUpdatedAt, nextRevision, now, draft.updatedByLogin, draftId,
        ));
        (await db.prepare("DELETE FROM branch_order_draft_lines WHERE draft_id = ?").run(draftId));
      } else {
        (await db.prepare(`
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
        ));
      }
      const insertLine = db.prepare(`
        INSERT INTO branch_order_draft_lines
          (draft_id, item_id, item_title_snapshot, unit_snapshot, quantity, note, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const line of draft.lines) {
        (await insertLine.run(
          draftId, line.itemId, line.itemTitle, line.unit,
          line.quantity, line.note, line.sortOrder,
        ));
      }
    }));
    return (await draftSnapshot(locationId, input));
  }

  async function deleteDraft(locationId, input = {}) {
    const scope = normalizedDraftScope(input);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    const expectedRevision = normalizedDraftRevision(input.expectedRevision);
    return (await transaction(async () => {
      const existing = (await db.prepare(`
        SELECT id, revision
        FROM branch_order_drafts
        WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
      `).get(String(locationId), scope.ownerAccountId, employeeNumber));
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
      return Number((await db.prepare("DELETE FROM branch_order_drafts WHERE id = ?").run(String(existing.id))).changes || 0) > 0;
    }));
  }

  async function normalizeConfiguration(locationId, input = {}) {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw branchOrderError("Die Bestellkonfiguration ist ungültig.", "BRANCH_ORDER_CONFIGURATION_INVALID");
    }
    if (!Array.isArray(input.recipients) || !Array.isArray(input.units) || !Array.isArray(input.groups)) {
      throw branchOrderError("E-Mail-Ziele, Einheiten und Gruppen müssen vollständig übermittelt werden.", "BRANCH_ORDER_CONFIGURATION_INVALID");
    }
    if (input.recipients.length > 60 || input.units.length > 80 || input.groups.length > 80) {
      throw branchOrderError("Die Bestellkonfiguration ist zu umfangreich.", "BRANCH_ORDER_CONFIGURATION_TOO_LARGE");
    }
    const idsForLocation = async (table) => new Set((await db.prepare(`
      SELECT id FROM ${table} WHERE location_id = ?
    `).all(String(locationId))).map((row) => String(row.id)));
    const existingRecipientsById = new Map((await db.prepare(`
      SELECT id, cc_email AS ccEmail,
             primary_delivery_mode AS primaryDeliveryMode,
             cc_delivery_mode AS ccDeliveryMode
      FROM branch_order_recipients
      WHERE location_id = ?
    `).all(String(locationId))).map((row) => [String(row.id), row]));
    const existingRecipientIds = new Set(existingRecipientsById.keys());
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
      const existingRecipient = existingRecipientsById.get(reference) || null;
      const email = normalizedEmail(source.email, "Die Zieladresse");
      if (emailSet.has(email)) {
        throw branchOrderError("Eine Zieladresse darf nur einmal angelegt werden.", "BRANCH_ORDER_CONFIGURATION_INVALID");
      }
      emailSet.add(email);
      const ccEmail = normalizedOptionalEmail(
        Object.hasOwn(source, "ccEmail") ? source.ccEmail : existingRecipient?.ccEmail,
        "Die CC-Adresse",
      );
      if (ccEmail && ccEmail === email) {
        throw branchOrderError(
          "Die CC-Adresse muss sich von der primären Zieladresse unterscheiden.",
          "BRANCH_ORDER_CC_EMAIL_DUPLICATE",
        );
      }
      const suppliedReplyToEmail = String(source.replyToEmail || "").trim();
      const replyToEmail = suppliedReplyToEmail
        ? normalizedEmail(suppliedReplyToEmail, "Die Antwortadresse")
        : email;
      const recipient = {
        id: retainedOrNewId(reference, existingRecipientIds),
        email,
        ccEmail,
        primaryDeliveryMode: normalizedDeliveryMode(
          Object.hasOwn(source, "primaryDeliveryMode")
            ? source.primaryDeliveryMode
            : existingRecipient?.primaryDeliveryMode,
          "Die Versandart der primären Zieladresse",
        ),
        ccDeliveryMode: normalizedDeliveryMode(
          Object.hasOwn(source, "ccDeliveryMode")
            ? source.ccDeliveryMode
            : existingRecipient?.ccDeliveryMode,
          "Die Versandart der CC-Adresse",
        ),
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

  async function replaceConfiguration(locationId, input, actor = "", options = {}) {
    (await ensureLocationConfiguration(locationId, actor || "system"));
    const normalized = (await normalizeConfiguration(locationId, input));
    const requiresPdfDelivery = normalized.recipients.some((recipient) => (
      recipient.primaryDeliveryMode !== "message"
      || (recipient.ccEmail && recipient.ccDeliveryMode !== "message")
    ));
    if (options.pdfDeliveryAvailable === false && requiresPdfDelivery) {
      throw branchOrderError(
        "Bestell-PDFs können erst nach Freischaltung eines SMTP-Versands aktiviert werden.",
        "BRANCH_ORDER_PDF_DELIVERY_UNAVAILABLE",
        409,
      );
    }
    const now = new Date().toISOString();
    (await transaction(async () => {
      (await db.prepare(`
        DELETE FROM branch_order_group_items
        WHERE group_id IN (SELECT id FROM branch_order_groups WHERE location_id = ?)
      `).run(String(locationId)));
      (await db.prepare("DELETE FROM branch_order_catalog_items WHERE location_id = ?").run(String(locationId)));
      (await db.prepare("DELETE FROM branch_order_groups WHERE location_id = ?").run(String(locationId)));
      (await db.prepare("DELETE FROM branch_order_units WHERE location_id = ?").run(String(locationId)));
      (await db.prepare("DELETE FROM branch_order_recipients WHERE location_id = ?").run(String(locationId)));
      for (const recipient of normalized.recipients) {
        (await db.prepare(`
          INSERT INTO branch_order_recipients
            (id, location_id, email, cc_email, primary_delivery_mode, cc_delivery_mode,
             reply_to_email, subject_template, body_template,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          recipient.id, String(locationId), recipient.email, recipient.ccEmail,
          recipient.primaryDeliveryMode, recipient.ccDeliveryMode, recipient.replyToEmail,
          recipient.subjectTemplate, recipient.bodyTemplate, now, actor, now, actor,
        ));
      }
      for (const [unitIndex, unit] of normalized.units.entries()) {
        (await db.prepare(`
          INSERT INTO branch_order_units
            (id, location_id, title, active, sort_order, created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(unit.id, String(locationId), unit.title, unitIndex + 1, now, actor, now, actor));
      }
      for (const [groupIndex, group] of normalized.groups.entries()) {
        (await db.prepare(`
          INSERT INTO branch_order_groups
            (id, location_id, recipient_id, title, hint, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, NULL, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          group.id, String(locationId), group.title, group.hint,
          groupIndex + 1, now, actor, now, actor,
        ));
      }
      for (const [itemIndex, item] of normalized.items.entries()) {
        (await db.prepare(`
          INSERT INTO branch_order_catalog_items
            (id, location_id, recipient_id, unit_id, title, active, sort_order,
             created_at, created_by, updated_at, updated_by)
          VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)
        `).run(
          item.id, String(locationId), item.recipientId, item.unitId, item.title,
          itemIndex + 1, now, actor, now, actor,
        ));
      }
      for (const group of normalized.groups) {
        for (const [itemIndex, itemId] of group.itemIds.entries()) {
          (await db.prepare(`
            INSERT INTO branch_order_group_items (group_id, item_id, sort_order)
            VALUES (?, ?, ?)
          `).run(group.id, itemId, itemIndex + 1));
        }
      }
      (await db.prepare(`
        UPDATE branch_order_location_settings
        SET updated_at = ?, updated_by = ?
        WHERE location_id = ?
      `).run(now, actor, String(locationId)));
    }));
    return (await settingsSnapshot(locationId));
  }

  async function preparedOrder(locationId, input = {}) {
    (await ensureLocationConfiguration(locationId));
    const location = (await locationRow(locationId));
    if (!location) throw branchOrderError("Die Filiale ist nicht aktiv.", "BRANCH_ORDER_LOCATION_INVALID", 404);
    const employeeNumber = textValue(input.selectedEmployeeNumber, {
      label: "Die Personalnummer", minimum: 1, maximum: 80,
    });
    const employee = (await activeEmployeeRow(locationId, employeeNumber));
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
    const configuration = (await settingsSnapshot(locationId));
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
    const deliveries = [...deliveryLines.values()].flatMap((recipientLines) => {
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
      const messageBody = `${renderTemplate(recipient.bodyTemplate, templateValues).trim()}${orderMailFooter(recipient.replyToEmail)}`;
      const destinations = [{
        recipientRole: "primary",
        recipientEmail: recipient.email,
        deliveryMode: recipient.primaryDeliveryMode,
      }];
      if (recipient.ccEmail) {
        destinations.push({
          recipientRole: "cc",
          recipientEmail: recipient.ccEmail,
          deliveryMode: recipient.ccDeliveryMode,
        });
      }
      if (!subject || /[\r\n]/.test(subject)
        || (destinations.some((destination) => destination.deliveryMode !== "pdf_only")
          && (!messageBody.trim() || messageBody.length > 12000))) {
        throw branchOrderError("Die E-Mail-Vorlage erzeugt keinen gültigen Versandinhalt.", "BRANCH_ORDER_TEMPLATE_INVALID", 409);
      }
      return destinations.map((destination) => ({
        id: crypto.randomUUID(),
        recipientConfigurationId: recipient.id,
        attachmentLines: recipientLines,
        senderEmail: normalizedEmail(input.senderEmail, "Der Absender"),
        recipientEmail: destination.recipientEmail,
        recipientRole: destination.recipientRole,
        deliveryMode: destination.deliveryMode,
        attachPdf: destination.deliveryMode !== "message",
        replyToEmail: recipient.replyToEmail,
        subject,
        body: destination.deliveryMode === "pdf_only" ? "" : messageBody,
      }));
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
    const order = (await preparedOrder(locationId, input));
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
    const attachmentPdfByRecipient = new Map();
    try {
      for (const delivery of order.deliveries) {
        if (!delivery.attachPdf) continue;
        let attachment = attachmentPdfByRecipient.get(delivery.recipientConfigurationId);
        if (!attachment) {
          const content = delivery.attachmentLines.length === order.lines.length
            ? Buffer.from(pdfContent)
            : Buffer.from(await renderBranchOrderPdf({ ...order, lines: delivery.attachmentLines }));
          attachment = {
            filename: pdfFilename,
            sha256: branchOrderPdfSha256(content),
            content,
          };
          attachmentPdfByRecipient.set(delivery.recipientConfigurationId, attachment);
        }
        delivery.attachmentFilename = attachment.filename;
        delivery.attachmentSha256 = attachment.sha256;
        delivery.attachmentContent = attachment.content;
      }
    } catch (error) {
      throw branchOrderError(
        "Der Bestellnachweis konnte nicht erzeugt werden.",
        "BRANCH_ORDER_PDF_GENERATION_FAILED",
        500,
      );
    }
    for (const delivery of order.deliveries) {
      delete delivery.recipientConfigurationId;
      delete delivery.attachmentLines;
    }
    let draftConsumed = false;
    (await transaction(async () => {
      const savedDraft = (await db.prepare(`
        SELECT id, revision
        FROM branch_order_drafts
        WHERE location_id = ? AND owner_account_id = ? AND selected_employee_number = ?
      `).get(order.location.id, order.draftScope.ownerAccountId, order.employee.employeeNumber));
      const actualDraftRevision = Number(savedDraft?.revision || 0);
      if (actualDraftRevision !== order.expectedDraftRevision) {
        throw branchOrderError(
          "Der gespeicherte Entwurf wurde zwischenzeitlich geändert. Bitte neu laden.",
          "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
          409,
        );
      }
      (await db.prepare(`
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
      ));
      for (const line of order.lines) {
        (await db.prepare(`
          INSERT INTO branch_order_lines
            (id, order_id, recipient_email, group_title, item_title, quantity, unit, note, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          line.id, order.id, line.recipient.email, line.groupTitle, line.itemTitle,
          line.quantity, line.unit, line.note, line.sortOrder,
        ));
      }
      for (const delivery of order.deliveries) {
        (await db.prepare(`
          INSERT INTO branch_order_deliveries
            (id, order_id, sender_email, recipient_email, recipient_role, delivery_mode,
             attachment_filename, attachment_sha256, reply_to_email,
             subject_snapshot, body_snapshot, status, failure_code, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
        `).run(
          delivery.id, order.id, delivery.senderEmail, delivery.recipientEmail,
          delivery.recipientRole, delivery.deliveryMode,
          delivery.attachPdf ? delivery.attachmentFilename : "",
          delivery.attachPdf ? delivery.attachmentSha256 : "",
          delivery.replyToEmail, delivery.subject, delivery.body,
          order.submittedAt, order.submittedAt,
        ));
      }
      if (savedDraft) {
        const deleted = (await db.prepare(`
          DELETE FROM branch_order_drafts
          WHERE id = ? AND revision = ?
        `).run(String(savedDraft.id), actualDraftRevision));
        if (Number(deleted.changes || 0) !== 1) {
          throw branchOrderError(
            "Der gespeicherte Entwurf konnte nicht abgeschlossen werden. Bitte neu laden.",
            "BRANCH_ORDER_DRAFT_REVISION_CONFLICT",
            409,
          );
        }
        draftConsumed = true;
      }
    }));
    order.pdf = {
      filename: pdfFilename,
      sha256: pdfSha256,
      generatedAt: pdfGeneratedAt,
    };
    order.pdfContent = Buffer.from(pdfContent);
    order.draftConsumed = draftConsumed;
    return order;
  }

  async function markDelivery(deliveryId, { status, failureCode = "", attemptedAt = new Date().toISOString() } = {}) {
    if (!["pending", "sent", "failed"].includes(status)) {
      throw branchOrderError("Der Versandstatus ist ungültig.", "BRANCH_ORDER_DELIVERY_INVALID");
    }
    const result = (await db.prepare(`
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
    ));
    return Number(result.changes || 0) > 0;
  }

  async function finalizeOrder(orderId, updatedAt = new Date().toISOString()) {
    const aggregate = (await db.prepare(`
      SELECT COUNT(*) AS count,
             SUM(CASE WHEN status = 'sent' THEN 1 ELSE 0 END) AS sentCount,
             SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failedCount,
             SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pendingCount
      FROM branch_order_deliveries
      WHERE order_id = ?
    `).get(String(orderId)));
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
    (await db.prepare(`
      UPDATE branch_orders
      SET status = ?, updated_at = ?
      WHERE id = ?
    `).run(status, updatedAt, String(orderId)));
    return {
      status,
      total: count,
      sent: sentCount,
      failed: Number(aggregate?.failedCount || 0),
      pending: pendingCount,
    };
  }

  async function confirmOrderDeliveries(locationId, orderId, confirmedAt = new Date().toISOString()) {
    const order = (await db.prepare(`
      SELECT id FROM branch_orders WHERE id = ? AND location_id = ?
    `).get(String(orderId), String(locationId)));
    if (!order) {
      throw branchOrderError("Die Bestellung wurde für diesen Standort nicht gefunden.", "BRANCH_ORDER_NOT_FOUND", 404);
    }
    const result = (await db.prepare(`
      UPDATE branch_order_deliveries
      SET status = 'sent', failure_code = '', attempted_at = COALESCE(attempted_at, ?),
          sent_at = COALESCE(sent_at, ?), updated_at = ?
      WHERE order_id = ? AND status IN ('pending', 'failed')
    `).run(confirmedAt, confirmedAt, confirmedAt, String(orderId)));
    return {
      changed: Number(result.changes || 0),
      ...(await finalizeOrder(orderId, confirmedAt)),
    };
  }

  async function history(locationId, limit = 50, { selectedEmployeeNumber = "" } = {}) {
    const safeLimit = Number.isSafeInteger(Number(limit))
      ? Math.max(1, Math.min(100, Number(limit)))
      : 50;
    const scopedEmployeeNumber = String(selectedEmployeeNumber || "").trim();
    const orders = (await db.prepare(`
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
      : [String(locationId), safeLimit]))).map((row) => ({
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
             recipient_role AS recipientRole, delivery_mode AS deliveryMode,
             attachment_filename AS attachmentFilename, attachment_sha256 AS attachmentSha256,
             status, failure_code AS failureCode, attempted_at AS attemptedAt, sent_at AS sentAt
      FROM branch_order_deliveries
      WHERE order_id = ?
      ORDER BY id
    `);
    for (const order of byId.values()) {
      order.lines = (await linesForOrder.all(order.id)).map((line) => ({
        ...line,
        quantity: Number(line.quantity),
        sortOrder: Number(line.sortOrder),
      }));
      order.deliveries = (await deliveriesForOrder.all(order.id));
    }
    return orders;
  }

  async function orderForPdf(locationId, orderId, { selectedEmployeeNumber = "" } = {}) {
    const scopedEmployeeNumber = String(selectedEmployeeNumber || "").trim();
    const order = (await db.prepare(`
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
      : [String(orderId), String(locationId)])));
    if (!order) {
      throw branchOrderError("Die Bestellung wurde für diesen Standort nicht gefunden.", "BRANCH_ORDER_NOT_FOUND", 404);
    }
    order.lines = (await db.prepare(`
      SELECT group_title AS groupTitle, item_title AS itemTitle, quantity, unit, note,
             sort_order AS sortOrder
      FROM branch_order_lines
      WHERE order_id = ?
      ORDER BY sort_order, id
    `).all(order.id)).map((line) => ({
      ...line,
      quantity: Number(line.quantity),
      sortOrder: Number(line.sortOrder),
    }));
    return order;
  }

  async function orderPdf(locationId, orderId, options = {}) {
    const order = (await orderForPdf(locationId, orderId, options));
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
    (await db.prepare(`
      UPDATE branch_orders
      SET pdf_filename = ?, pdf_sha256 = ?, pdf_content = ?, pdf_generated_at = ?
      WHERE id = ? AND location_id = ?
    `).run(filename, sha256, content, generatedAt, order.id, String(locationId)));
    return { filename, sha256, generatedAt, content };
  }

  return Object.freeze({
    branchPortalSettingsSnapshot,
    catalogSnapshot,
    createOrder,
    deleteDraft,
    draftSnapshot,
    ensureActiveBranchAccountBasePermissions,
    ensureConfiguredLocationCatalogContent,
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
  createPostgresqlBranchOrderOperations,
};
