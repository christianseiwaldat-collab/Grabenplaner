"use strict";
const test = require("node:test"), assert = require("node:assert/strict"), sharp = require("sharp");
const contact = require("../lib/emma-contact");

test("Emma contact: international numbers normalize without accepting URLs, local numbers or message injection", () => {
  for (const value of ["+43 (660) 123-4567", "0043 660 1234567", "436601234567"]) assert.equal(contact.phoneNumber(value), "436601234567");
  for (const value of ["06601234567", "+43+6601234567", "https://wa.me/436601234567", "436601234567?text=private", "436601234567\n", "1", "1234567890123456", 436601234567]) {
    assert.throws(() => contact.phoneNumber(value), error => error.code === "EMMA_CONTACT_INVALID");
  }
});
test("Emma contact: disabled by default, only explicit activation publishes the contact", async () => {
  assert.equal(contact.publicContact(), null);
  const settings = await contact.validateSettings({ enabled: true, avatar: "" });
  assert.deepEqual(contact.publicContact(JSON.stringify(settings), "+43 660 1234567"), { href: "https://wa.me/436601234567", avatar: "/assets/emma-whatsapp.png" });
  assert.equal(contact.publicContact(JSON.stringify(settings)), null);
  assert.equal(contact.publicContact(JSON.stringify(settings), "javascript:alert(1)"), null);
  assert.equal(contact.publicContact(JSON.stringify({ ...settings, enabled: false })), null);
  assert.equal(contact.publicContact('{"enabled":true,"phone":"javascript:alert(1)","avatar":""}'), null);
  for (const value of [null, [], { enabled: "true", avatar: "" }, { enabled: true, phone: "436601234567", avatar: "" }, { enabled: false, avatar: "", url: "https://other.test" }]) {
    await assert.rejects(contact.validateSettings(value), error => error.code === "EMMA_CONTACT_INVALID");
  }
});
test("Emma contact: real image re-encoding removes metadata and bounds its dimensions", async () => {
  const original = await sharp({ create: { width: 400, height: 300, channels: 3, background: "#ec3b3b" } }).withMetadata({ exif: { IFD0: { Artist: "synthetic private metadata" } } }).jpeg().toBuffer();
  const result = await contact.avatarImage("data:image/jpeg;base64," + original.toString("base64"));
  const metadata = await sharp(Buffer.from(result.split(",")[1], "base64")).metadata();
  assert.equal(metadata.format, "webp"); assert.equal(metadata.width, 192); assert.equal(metadata.height, 192);
  assert.equal(metadata.exif, undefined); assert.equal(metadata.xmp, undefined);
});
test("Emma contact: rejects malformed, external, active, oversized and mismatched images", async () => {
  const png = await sharp({ create: { width: 8, height: 8, channels: 3, background: "white" } }).png().toBuffer();
  for (const avatar of ["https://tracking.example.test/avatar.png", "data:image/svg+xml;base64,PHN2Zy8+", "data:image/png;base64,YmFk", "data:image/jpeg;base64," + png.toString("base64"), "data:image/png;base64," + "A".repeat(400000)]) {
    await assert.rejects(contact.avatarImage(avatar), error => error.code === "EMMA_CONTACT_INVALID");
  }
});
test("Emma contact: revision changes with stored data, malformed storage fails closed", () => {
  assert.notEqual(contact.settingsPayload("").revision, contact.settingsPayload('{}').revision);
  assert.equal(contact.publicContact("broken"), null);
  assert.equal(contact.publicContact(JSON.stringify({ enabled: true, phone: "436601234567", avatar: "https://tracking.example.test" })), null);
});
