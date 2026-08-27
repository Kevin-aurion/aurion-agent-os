import { deflateRawSync } from 'node:zlib';

export interface ZipEntry {
  path: string;
  content: Buffer | string;
}

const MAX_ENTRIES = 1_000;
const MAX_UNCOMPRESSED_BYTES = 50 * 1024 * 1024;
const UINT32_MAX = 0xffff_ffff;

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let value = n;
    for (let k = 0; k < 8; k++) {
      value = (value & 1) !== 0 ? 0xedb8_8320 ^ (value >>> 1) : value >>> 1;
    }
    table[n] = value >>> 0;
  }
  return table;
})();

function crc32(input: Buffer): number {
  let crc = 0xffff_ffff;
  for (const byte of input) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffff_ffff) >>> 0;
}

export function assertPortableZipPath(value: string): string {
  if (!value || value.includes('\0') || value.includes('\\') || value.startsWith('/')) {
    throw new Error(`unsafe ZIP entry path: ${value}`);
  }
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) {
    throw new Error(`unsafe ZIP entry path: ${value}`);
  }
  return value;
}

function dosTimestamp(date: Date): { time: number; day: number } {
  const year = Math.max(1980, Math.min(2107, date.getUTCFullYear()));
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Create a bounded ZIP32 archive without shelling out or accepting filesystem paths. */
export function createZipArchive(entries: ZipEntry[], modifiedAt = new Date()): Buffer {
  if (!entries.length) throw new Error('ZIP archive requires at least one entry');
  if (entries.length > MAX_ENTRIES) throw new Error(`ZIP entry limit exceeded (${MAX_ENTRIES})`);

  const seen = new Set<string>();
  let uncompressedTotal = 0;
  let offset = 0;
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  const stamp = dosTimestamp(modifiedAt);

  for (const entry of entries) {
    const entryPath = assertPortableZipPath(entry.path);
    if (seen.has(entryPath)) throw new Error(`duplicate ZIP entry path: ${entryPath}`);
    seen.add(entryPath);

    const name = Buffer.from(entryPath, 'utf8');
    const body = Buffer.isBuffer(entry.content) ? entry.content : Buffer.from(entry.content, 'utf8');
    uncompressedTotal += body.length;
    if (uncompressedTotal > MAX_UNCOMPRESSED_BYTES) {
      throw new Error(`ZIP uncompressed size limit exceeded (${MAX_UNCOMPRESSED_BYTES})`);
    }
    const compressed = deflateRawSync(body, { level: 9 });
    if (body.length > UINT32_MAX || compressed.length > UINT32_MAX || offset > UINT32_MAX) {
      throw new Error('ZIP64 archives are not supported');
    }
    const crc = crc32(body);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(stamp.time, 10);
    local.writeUInt16LE(stamp.day, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(body.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    localParts.push(local, name, compressed);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(8, 10);
    central.writeUInt16LE(stamp.time, 12);
    central.writeUInt16LE(stamp.day, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(compressed.length, 20);
    central.writeUInt32LE(body.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centralParts.push(central, name);

    offset += local.length + name.length + compressed.length;
  }

  const centralDirectory = Buffer.concat(centralParts);
  if (offset + centralDirectory.length > UINT32_MAX) throw new Error('ZIP64 archives are not supported');
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);

  return Buffer.concat([...localParts, centralDirectory, end]);
}
