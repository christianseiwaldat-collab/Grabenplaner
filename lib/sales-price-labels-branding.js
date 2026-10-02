'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const MAX_ASSET_BYTES = 8 * 1024 * 1024;
const fail = () => { throw Object.assign(new Error('Das ausgewählte Drucklogo ist nicht mehr verfügbar. Bitte das Branding-Kit neu auswählen.'), { code: 'PRICE_LABEL_LOGO', status: 400 }); };

function createSalesPriceLabelsBranding({ listKits, kitsDirectory, publicDirectory }) {
  function assetLocation(url) {
    if (typeof url !== 'string' || url.length > 500 || /[\\?#\u0000-\u001f]/u.test(url)) return null;
    const parts = url.split('/').slice(1);
    if (parts.some(part => !part || part === '.' || part === '..' || !/^[a-zA-Z0-9._-]+$/u.test(part))) return null;
    if (parts[0] === 'branding-kits' && parts.length === 4 && parts[2] === 'assets') return { root: kitsDirectory, parts: parts.slice(1) };
    if (parts[0] === 'assets' && parts.length >= 2) return { root: publicDirectory, parts };
    return null;
  }
  async function list() {
    const kits = (await listKits()).flatMap(kit => {
      if (!kit || typeof kit.id !== 'string' || !/^[a-zA-Z0-9-]{1,120}$/u.test(kit.id)) return [];
      const logos = [['logo', 'Firmenlogo', kit.branding?.logoUrl], ['icon', 'Symbol', kit.branding?.iconUrl]]
        .flatMap(([key, label, url]) => assetLocation(url) ? [{ key, label, url }] : []);
      return logos.length ? [{ id: kit.id, name: String(kit.name || 'Branding-Kit').slice(0, 160), logos }] : [];
    });
    return { kits };
  }
  async function content({ logoKitId, logoAssetKey }) {
    const kit = (await list()).kits.find(row => row.id === logoKitId);
    const asset = kit?.logos.find(row => row.key === logoAssetKey);
    if (!asset) fail();
    const location = assetLocation(asset.url);
    try {
      const root = await fs.realpath(location.root), target = path.resolve(root, ...location.parts);
      if (!target.startsWith(root + path.sep)) fail();
      const resolved = await fs.realpath(target), info = await fs.lstat(target);
      if (!resolved.startsWith(root + path.sep) || info.isSymbolicLink() || !info.isFile() || info.size > MAX_ASSET_BYTES || !info.size) fail();
      const buffer = await fs.readFile(resolved);
      if (!buffer.length || buffer.length > MAX_ASSET_BYTES) fail();
      return buffer;
    } catch { fail(); }
  }
  return Object.freeze({ list, content });
}

module.exports = { createSalesPriceLabelsBranding, MAX_ASSET_BYTES };
