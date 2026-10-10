// ZIP (store), UTF-8 names, CRC-32. Images are already compressed; no external library is required.
const encoder = new TextEncoder();
const crcTable = Uint32Array.from({ length: 256 }, (_, value) => {
  for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  return value >>> 0;
});

export function crc32(data) {
  let crc = 0xffffffff;
  for (const byte of data) crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function header(size) {
  const bytes = new Uint8Array(size);
  return { bytes, view: new DataView(bytes.buffer) };
}

export function createZip(entries, date = new Date()) {
  if (!entries.length || entries.length > 65535) throw new Error('Ungültige Anzahl ZIP-Dateien.');
  const year = Math.min(2107, Math.max(1980, date.getFullYear()));
  const dosDate = ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
  const dosTime = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
  const files = [];
  const directory = [];
  const seen = new Set();
  let offset = 0;
  let directorySize = 0;
  for (const entry of entries) {
    if (!entry.name || /[\\\x00-\x1f]/.test(entry.name) || entry.name.split('/').some(part => !part || part === '.' || part === '..') || seen.has(entry.name.toLowerCase())) throw new Error('Ungültiger oder doppelter ZIP-Dateiname.');
    seen.add(entry.name.toLowerCase());
    const name = encoder.encode(entry.name);
    const data = typeof entry.data === 'string' ? encoder.encode(entry.data) : entry.data;
    if (!(data instanceof Uint8Array) || name.length > 65535 || data.length > 0xffffffff) throw new Error('Datei überschreitet das ZIP-Limit.');
    const crc = crc32(data);
    const local = header(30);
    local.view.setUint32(0, 0x04034b50, true);
    local.view.setUint16(4, 20, true);
    local.view.setUint16(6, 0x0800, true);
    local.view.setUint16(10, dosTime, true);
    local.view.setUint16(12, dosDate, true);
    local.view.setUint32(14, crc, true);
    local.view.setUint32(18, data.length, true);
    local.view.setUint32(22, data.length, true);
    local.view.setUint16(26, name.length, true);
    files.push(local.bytes, name, data);
    const central = header(46);
    central.view.setUint32(0, 0x02014b50, true);
    central.view.setUint16(4, 20, true);
    central.view.setUint16(6, 20, true);
    central.view.setUint16(8, 0x0800, true);
    central.view.setUint16(12, dosTime, true);
    central.view.setUint16(14, dosDate, true);
    central.view.setUint32(16, crc, true);
    central.view.setUint32(20, data.length, true);
    central.view.setUint32(24, data.length, true);
    central.view.setUint16(28, name.length, true);
    central.view.setUint32(42, offset, true);
    directory.push(central.bytes, name);
    offset += 30 + name.length + data.length;
    directorySize += 46 + name.length;
    if (offset + directorySize + 22 > 0xffffffff) throw new Error('Das Paket ist für dieses ZIP-Format zu groß.');
  }
  const end = header(22);
  end.view.setUint32(0, 0x06054b50, true);
  end.view.setUint16(8, entries.length, true);
  end.view.setUint16(10, entries.length, true);
  end.view.setUint32(12, directorySize, true);
  end.view.setUint32(16, offset, true);
  return new Blob([...files, ...directory, end.bytes], { type: 'application/zip' });
}
