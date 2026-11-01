"use strict";

const crypto = require("node:crypto");
const sharp = require("sharp");
const SETTINGS_KEY = "emma_whatsapp_contact_v1";
const MAX_IMAGE_BYTES = 256 * 1024;
const EMPLOYEE_NUMBER = "Emma";
const DEFAULTS = Object.freeze({ enabled: false, avatar: "" });

function invalid(message = "Bitte Emmas WhatsApp-Einstellungen prüfen.") {
  return Object.assign(new Error(message), { status: 400, code: "EMMA_CONTACT_INVALID" });
}

function phoneNumber(value) {
  if (typeof value !== "string" || value.length > 50 || /[^+0-9 ()-]/.test(value)) throw invalid("Bitte eine internationale WhatsApp-Nummer mit Landesvorwahl eingeben.");
  const phone = value.replace(/[ ()-]/g, "").replace(/^(?:\+|00)/, "");
  if (phone && !/^[1-9][0-9]{6,14}$/.test(phone)) throw invalid("Bitte eine internationale WhatsApp-Nummer mit Landesvorwahl eingeben.");
  return phone;
}

async function avatarImage(value) {
  if (value === "") return "";
  if (typeof value !== "string" || value.length > MAX_IMAGE_BYTES * 1.4) throw invalid("Das Profilbild darf höchstens 256 KB groß sein.");
  const match = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
  if (!match) throw invalid("Bitte ein PNG-, JPEG- oder WebP-Bild auswählen.");
  const bytes = Buffer.from(match[2], "base64");
  if (bytes.length > MAX_IMAGE_BYTES || bytes.toString("base64") !== match[2]) throw invalid();
  try {
    const image = sharp(bytes, { limitInputPixels: 16000000, failOn: "warning" });
    const metadata = await image.metadata();
    if (metadata.format !== match[1] || (metadata.pages || 1) !== 1) throw invalid();
    // Decode and re-encode: no SVG, external URL, animation, EXIF or original file.
    const output = await image.rotate().resize(192, 192, { fit: "cover" }).webp({ quality: 85 }).toBuffer();
    return `data:image/webp;base64,${output.toString("base64")}`;
  } catch { throw invalid("Das Bild konnte nicht gelesen werden. Bitte ein gültiges PNG-, JPEG- oder WebP-Bild auswählen."); }
}

async function validateSettings(value) {
  if (!value || Array.isArray(value) || typeof value !== "object"
    || Object.keys(value).some(key => !["enabled", "avatar"].includes(key))
    || typeof value.enabled !== "boolean") throw invalid();
  return { enabled: value.enabled, avatar: await avatarImage(value.avatar) };
}

function storedSettings(raw) {
  try {
    const value = JSON.parse(raw || "null");
    if (!value || typeof value.enabled !== "boolean"
      || Object.keys(value).some(key => !["enabled", "avatar"].includes(key))
      || typeof value.avatar !== "string" || value.avatar.length > MAX_IMAGE_BYTES * 1.4
      || (value.avatar && !/^data:image\/webp;base64,[A-Za-z0-9+/]+={0,2}$/.test(value.avatar))) return { ...DEFAULTS };
    return { enabled: value.enabled, avatar: value.avatar };
  } catch { return { ...DEFAULTS }; }
}

function settingsPayload(raw, phone = "") {
  return { settings: storedSettings(raw), phone, employeeNumber: EMPLOYEE_NUMBER, revision: crypto.createHash("sha256").update(raw || "").digest("hex") };
}

function publicContact(raw, personnelPhone = "") {
  const settings = storedSettings(raw);
  try {
    const phone = phoneNumber(personnelPhone);
    return settings.enabled && phone ? { href: `https://wa.me/${phone}`, avatar: settings.avatar || "/assets/emma-whatsapp.png" } : null;
  } catch { return null; }
}

module.exports = { SETTINGS_KEY, EMPLOYEE_NUMBER, MAX_IMAGE_BYTES, phoneNumber, avatarImage, validateSettings, storedSettings, settingsPayload, publicContact };
