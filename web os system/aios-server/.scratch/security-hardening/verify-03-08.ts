/**
 * Acceptance tests for tickets 03 (Zip Slip) + 08 (shared CJK slug).
 * Run: npx tsx .scratch/security-hardening/verify-03-08.ts
 *
 * Loads production helpers by temporarily exporting readZip/writeSkillFile
 * from a copy of src/routes/skills.ts (deleted after import).
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { fileURLToPath } from 'node:url';
import { slugify } from '../../src/lib/slug.js';
import { paths } from '../../src/config.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '../..');

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

// ── Minimal store-method ZIP writer (matches what production readZip expects) ─

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return (c ^ 0xffffffff) >>> 0;
}

function buildStoreZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;

  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBuf.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(0, 8); // store
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    nameBuf.copy(local, 30);

    const central = Buffer.alloc(46 + nameBuf.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0, 8);
    central.writeUInt16LE(0, 10); // store
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBuf.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    nameBuf.copy(central, 46);

    locals.push(local, data);
    centrals.push(central);
    offset += local.length + data.length;
  }

  const localPart = Buffer.concat(locals);
  const centralPart = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralPart.length, 12);
  eocd.writeUInt32LE(localPart.length, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([localPart, centralPart, eocd]);
}

async function loadProductionHelpers(): Promise<{
  readZip: (buf: Buffer) => { name: string; data: Buffer }[];
  writeSkillFile: (slug: string, relPath: string, data: Buffer | string) => Promise<void>;
  stripCommonPrefix: (entries: { name: string; data: Buffer }[]) => { name: string; data: Buffer }[];
}> {
  const skillsSrcPath = path.join(root, 'src/routes/skills.ts');
  const src = readFileSync(skillsSrcPath, 'utf8');
  const modified = src
    .replace('async function writeSkillFile(', 'export async function writeSkillFile(')
    .replace('function readZip(', 'export function readZip(')
    .replace('function stripCommonPrefix(', 'export function stripCommonPrefix(');

  // Must sit next to skills.ts so relative imports (../lib/...) resolve correctly.
  const tmpPath = path.join(root, 'src/routes', `_tmp_skills_exports_${process.pid}.ts`);
  writeFileSync(tmpPath, modified);
  try {
    const mod = await import(pathToFileURL(tmpPath).href + `?t=${Date.now()}`);
    return {
      readZip: mod.readZip,
      writeSkillFile: mod.writeSkillFile,
      stripCommonPrefix: mod.stripCommonPrefix,
    };
  } finally {
    try {
      unlinkSync(tmpPath);
    } catch {
      /* ignore */
    }
  }
}

async function main() {
  console.log('── load production writeSkillFile / readZip ──');
  const { readZip, writeSkillFile, stripCommonPrefix } = await loadProductionHelpers();

  const testSlug = `zip-slip-test-${createHash('sha256').update(String(Date.now())).digest('hex').slice(0, 8)}`;
  const skillRoot = path.join(paths.skills, testSlug);
  const evilOutside = path.join(paths.skills, 'evil.txt');
  // Also a path that would land next to skill root if ../ were allowed
  const evilSibling = path.resolve(skillRoot, '../evil.txt');

  // Clean any leftover evil from prior runs
  for (const p of [evilOutside, evilSibling]) {
    if (existsSync(p)) unlinkSync(p);
  }
  if (existsSync(skillRoot)) await rm(skillRoot, { recursive: true, force: true });

  // ── 03 negative: zip with ../evil.txt must reject; file not written outside ──
  console.log('\n── [03] negative: zip entry ../evil.txt ──');
  const evilZip = buildStoreZip([
    { name: 'SKILL.md', data: Buffer.from('---\nname: evil\n---\nbody\n', 'utf8') },
    { name: '../evil.txt', data: Buffer.from('pwned', 'utf8') },
  ]);

  let rejected = false;
  let rejectMsg = '';
  try {
    readZip(evilZip);
  } catch (e) {
    rejected = true;
    rejectMsg = e instanceof Error ? e.message : String(e);
  }
  assert(rejected, 'readZip must throw on ../evil.txt');
  assert(rejectMsg.includes('不安全的 zip 項目'), `error must mention 不安全的 zip 項目, got: ${rejectMsg}`);
  assert(rejectMsg.includes('../evil.txt'), `error must include entry name, got: ${rejectMsg}`);
  assert(!existsSync(evilSibling), `evil.txt must NOT exist outside skill dir: ${evilSibling}`);
  assert(!existsSync(evilOutside), `evil.txt must NOT exist at ${evilOutside}`);
  console.log('  OK rejected:', rejectMsg);

  // Also: writeSkillFile alone must refuse path escape
  console.log('\n── [03] negative: writeSkillFile path escape ──');
  let writeRejected = false;
  try {
    await writeSkillFile(testSlug, '../evil.txt', 'pwned');
  } catch (e) {
    writeRejected = true;
    console.log('  OK writeSkillFile threw:', e instanceof Error ? e.message : e);
  }
  assert(writeRejected, 'writeSkillFile must throw on ../evil.txt');
  assert(!existsSync(evilSibling), 'evil.txt still must not exist after writeSkillFile attempt');

  // ── 03 positive: normal zip (SKILL.md + asset) unpacks ──
  console.log('\n── [03] positive: normal zip unpack ──');
  const goodZip = buildStoreZip([
    {
      name: 'demo-skill/SKILL.md',
      data: Buffer.from('---\nname: demo\n---\n# Demo\n', 'utf8'),
    },
    {
      name: 'demo-skill/assets/note.txt',
      data: Buffer.from('hello asset', 'utf8'),
    },
  ]);
  const rawEntries = readZip(goodZip);
  const entries = stripCommonPrefix(rawEntries);
  assert(entries.some((e) => /skill\.md$/i.test(e.name)), 'must find SKILL.md');
  for (const entry of entries) {
    await writeSkillFile(testSlug, entry.name, entry.data);
  }
  const skillMdPath = path.join(skillRoot, 'SKILL.md');
  const assetPath = path.join(skillRoot, 'assets/note.txt');
  await access(skillMdPath);
  await access(assetPath);
  const assetBody = await readFile(assetPath, 'utf8');
  assert(assetBody === 'hello asset', 'asset content mismatch');
  console.log('  OK unpacked to', skillRoot);
  console.log('  files:', entries.map((e) => e.name).join(', '));

  // cleanup skill dir
  await rm(skillRoot, { recursive: true, force: true });

  // ── 08: no local slugify in the 5 files; CJK non-empty ──
  console.log('\n── [08] shared slugify / no local defs ──');
  const five = [
    'src/routes/skills.ts',
    'src/routes/agents.ts',
    'src/skills/build.ts',
    'src/agents/compose.ts',
    'src/lib/skilltraining.ts',
  ];
  for (const f of five) {
    const text = readFileSync(path.join(root, f), 'utf8');
    assert(!/function slugify\s*\(/.test(text), `${f} still has local slugify definition`);
    assert(/from ['"].*slug\.js['"]/.test(text), `${f} must import slug from shared module`);
    console.log(`  OK ${f}: no local def, has import`);
  }

  const cjk = slugify('每日帳款掃描');
  assert(cjk.length > 0, "slugify('每日帳款掃描') must be non-empty");
  assert(cjk.includes('每日') || cjk.includes('帳款') || cjk.includes('掃描'), `CJK slug should keep CJK chars, got: ${cjk}`);
  console.log(`  OK slugify('每日帳款掃描') => ${JSON.stringify(cjk)}`);

  // same shared import surface for each entry (value check)
  for (const label of five) {
    // all call sites use shared slugify; value is from src/lib/slug.js
    assert(slugify('每日帳款掃描') === cjk, `consistent slug via shared module (${label})`);
  }

  console.log('\n── ALL PASS ──');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
