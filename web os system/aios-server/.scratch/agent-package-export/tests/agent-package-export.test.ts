import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import Fastify from 'fastify';
import { ulid } from 'ulid';

process.env.MEMORY_ENABLED = 'true';
const execFileAsync = promisify(execFile);

const { prisma } = await import('../../../src/lib/db.js');
const { signAccess } = await import('../../../src/lib/auth.js');
const { config, paths } = await import('../../../src/config.js');
const { materializeAgent } = await import('../../../src/engine/materialize.js');
const { agentBuilderRoutes } = await import('../../../src/routes/agentbuilder.js');
const { createZipArchive } = await import('../../../src/lib/ziparchive.js');

function sha256(body: Buffer): string {
  return createHash('sha256').update(body).digest('hex');
}

const ids = {
  owner: ulid(),
  foreign: ulid(),
  trainer: ulid(),
  scopedOwner: ulid(),
  agent: ulid(),
  confirmedSkill: ulid(),
  pendingSkill: ulid(),
  workflow: ulid(),
  step: ulid(),
  schedule: ulid(),
  activeSession: ulid(),
  draftSession: ulid(),
  foreignSession: ulid(),
  iteration: ulid(),
};
const suffix = ids.agent.slice(-8).toLowerCase();
const agentSlug = `portable-agent-${suffix}`;
const skillSlug = `portable-skill-${suffix}`;
const pendingSlug = `pending-skill-${suffix}`;
const secret = 'sk-exporttest-1234567890';
const emailSecret = 'secret-client@example.com';
const skillRoot = path.join(paths.skills, skillSlug);
const pendingRoot = path.join(paths.skills, pendingSlug);
let agentDir = path.join(paths.agents, `Export-${suffix}`, agentSlug);
let extractionRoot: string | null = null;

async function createFixtures() {
  await prisma.user.createMany({
    data: [
      { id: ids.owner, email: `export-owner-${suffix}@test.local`, displayName: 'Export Owner', passwordHash: 'x', role: 'MEMBER' },
      { id: ids.foreign, email: `export-foreign-${suffix}@test.local`, displayName: 'Export Foreign', passwordHash: 'x', role: 'MEMBER' },
      { id: ids.trainer, email: `export-trainer-${suffix}@test.local`, displayName: 'Export Trainer', passwordHash: 'x', role: 'TRAINER' },
      { id: ids.scopedOwner, email: `export-scoped-${suffix}@test.local`, displayName: 'Scoped Owner', passwordHash: 'x', role: 'OWNER' },
    ],
  });
  await mkdir(path.join(skillRoot, 'assets', 'templates'), { recursive: true });
  await mkdir(pendingRoot, { recursive: true });
  const templateRelative = `assets/templates/${emailSecret}.txt`;
  await writeFile(path.join(skillRoot, templateRelative), `template contains ${secret} and ${emailSecret}\n`);
  await writeFile(path.join(skillRoot, 'SKILL.md'), '# confirmed');
  await writeFile(path.join(pendingRoot, 'SKILL.md'), '# pending');

  await prisma.agent.create({
    data: {
      id: ids.agent,
      slug: agentSlug,
      name: 'Portable Export Agent',
      description: `A portable Agent with ${emailSecret}`,
      department: `Export-${suffix}`,
      rolePrompt: `Never reveal ${secret}; prepare reviewed output.`,
      engineExecute: 'CLAUDE_CODE',
      restrictions: { webSearch: true, cloudWrite: false, credential: secret },
      status: 'ACTIVE',
      // Legacy Builder approvals created the customer Agent under the FDE
      // actor. The owning ACTIVE session must still be able to export it.
      createdBy: ids.trainer,
    },
  });
  await prisma.skill.createMany({
    data: [
      {
        id: ids.confirmedSkill,
        slug: skillSlug,
        name: 'Confirmed portable skill',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: `# Confirmed\n\nUse ${secret} only as redaction test.`,
        assets: { templates: [{ path: templateRelative, sourceName: emailSecret, mimeType: 'text/plain', parsed: false }] },
        executionEnv: 'CLI',
        reviewStatus: 'CONFIRMED',
        confirmedBy: ids.trainer,
        confirmedAt: new Date(),
      },
      {
        id: ids.pendingSkill,
        slug: pendingSlug,
        name: 'Pending skill must not export',
        origin: 'CLI_GENERATED',
        kind: 'PROMPT_MANUAL',
        contentMd: '# Pending content must not export',
        executionEnv: 'CLI',
        reviewStatus: 'AWAITING_USER_CONFIRM',
      },
    ],
  });
  await prisma.agentSkill.createMany({
    data: [
      { agentId: ids.agent, skillId: ids.confirmedSkill },
      { agentId: ids.agent, skillId: ids.pendingSkill },
    ],
  });
  await prisma.workflow.create({
    data: {
      id: ids.workflow,
      agentId: ids.agent,
      name: 'Daily external sync',
      description: 'Must import disabled',
      enabled: true,
      trigger: { type: 'schedule' },
      steps: {
        create: {
          id: ids.step,
          position: 0,
          stepKey: 'prepare',
          type: 'DO',
          config: { prompt: `use ${secret}`, apiKey: 'short-credential-must-not-export', credentialRef: 'local-vault-reference' },
        },
      },
      schedules: {
        create: {
          id: ids.schedule,
          cron: '0 9 * * *',
          timezone: 'Asia/Taipei',
          enabled: true,
        },
      },
    },
  });
  await prisma.agentBuildSession.create({
    data: {
      id: ids.activeSession,
      userId: ids.owner,
      status: 'ACTIVE',
      strategy: 'create',
      builtAgentId: ids.agent,
      draftSkillIds: [ids.confirmedSkill],
      transcript: [{ role: 'user', content: `raw transcript ${secret}`, at: new Date().toISOString() }],
      testData: { customer: emailSecret, apiKey: secret },
      testExpected: { result: 'reviewed output' },
      testResult: { ok: true, status: 'PASSED', runId: `verified-run-${suffix}`, summary: `verified without ${secret}` },
      lastRunId: `verified-run-${suffix}`,
      iterations: {
        create: {
          id: ids.iteration,
          sequence: 1,
          triggerSummary: 'portable export test',
          status: 'READY',
          artifactSnapshot: { identity: { name: 'Portable Export Agent' }, secret },
          completedAt: new Date(),
        },
      },
    },
  });
  await prisma.agentBuildSession.create({
    data: {
      id: ids.draftSession,
      userId: ids.owner,
      status: 'DISCOVERY',
      transcript: [],
      builtAgentId: ids.agent,
    },
  });
  await prisma.agentBuildSession.create({
    data: {
      id: ids.foreignSession,
      userId: ids.foreign,
      status: 'ACTIVE',
      transcript: [],
    },
  });
  agentDir = await materializeAgent(ids.agent);
  await writeFile(path.join(agentDir, 'memory', 'wiki', `${emailSecret}.md`), `memory ${secret} ${emailSecret}\n`);
}

async function cleanup() {
  await prisma.agentBuildSession.deleteMany({
    where: { id: { in: [ids.activeSession, ids.draftSession, ids.foreignSession] } },
  }).catch(() => {});
  await prisma.agent.deleteMany({ where: { id: ids.agent } }).catch(() => {});
  await prisma.skill.deleteMany({ where: { id: { in: [ids.confirmedSkill, ids.pendingSkill] } } }).catch(() => {});
  await prisma.user.deleteMany({ where: { id: { in: [ids.owner, ids.foreign, ids.trainer, ids.scopedOwner] } } }).catch(() => {});
  await rm(skillRoot, { recursive: true, force: true });
  await rm(pendingRoot, { recursive: true, force: true });
  await rm(agentDir, { recursive: true, force: true });
  if (extractionRoot) await rm(extractionRoot, { recursive: true, force: true });
}

try {
  assert.throws(
    () => createZipArchive([{ path: '../escape.txt', content: 'no' }]),
    /unsafe ZIP entry path/,
    'ZIP writer must reject traversal paths',
  );
  await createFixtures();

  const app = Fastify({ logger: false });
  await app.register(agentBuilderRoutes);
  await app.ready();
  const ownerToken = await signAccess({ sub: ids.owner, email: 'owner@test.local', role: 'MEMBER' });
  const foreignToken = await signAccess({ sub: ids.foreign, email: 'foreign@test.local', role: 'MEMBER' });
  const trainerToken = await signAccess({ sub: ids.trainer, email: 'trainer@test.local', role: 'TRAINER' });
  const scopedOwnerToken = await signAccess({
    sub: ids.scopedOwner,
    email: 'scoped@test.local',
    role: 'OWNER',
    scope: 'aios:agent-builder',
    audience: config.remoteMcp.resourceUrl,
  });

  const activeUrl = `/api/agent-builder/sessions/${ids.activeSession}/export`;
  const exported = await app.inject({ method: 'GET', url: activeUrl, headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(exported.statusCode, 200);
  assert.match(exported.headers['content-type'] ?? '', /application\/zip/);
  assert.match(exported.headers['content-disposition'] ?? '', /attachment/);
  assert.equal(exported.headers['cache-control'], 'no-store');

  extractionRoot = await mkdtemp(path.join(os.tmpdir(), 'aios-agent-package-test-'));
  const zipPath = path.join(extractionRoot, 'package.zip');
  const extractPath = path.join(extractionRoot, 'unpacked');
  await writeFile(zipPath, exported.rawPayload);
  await mkdir(extractPath);
  await execFileAsync('/usr/bin/unzip', ['-qq', zipPath, '-d', extractPath]);
  const manifest = JSON.parse(await readFile(path.join(extractPath, 'manifest.json'), 'utf8')) as {
    kind: string;
    schemaVersion: string;
    skills: Array<{ name: string; entrypoint: string; templates: string[] }>;
    workflows: Array<{ path: string; enabledOnImport: boolean }>;
    governance: Record<string, boolean>;
    checksums: Record<string, string>;
  };
  assert.equal(manifest.kind, 'lazyoffice.aios.agent-package');
  assert.equal(manifest.schemaVersion, '1.0');
  assert.equal(manifest.skills.length, 1, 'only confirmed Skills may export');
  assert.equal(manifest.skills[0]?.name, 'Confirmed portable skill');
  assert.equal(manifest.workflows[0]?.enabledOnImport, false);
  assert.equal(manifest.governance.schedulesEnabledOnImport, false);
  assert.equal(manifest.governance.externalCredentialsIncluded, false);
  assert.equal(manifest.governance.requiresHumanReviewOnImport, true);
  for (const [relative, expectedHash] of Object.entries(manifest.checksums)) {
    const body = await readFile(path.join(extractPath, relative));
    assert.equal(sha256(body), expectedHash, `checksum mismatch: ${relative}`);
  }
  const workflow = JSON.parse(await readFile(path.join(extractPath, manifest.workflows[0]!.path), 'utf8')) as {
    enabledOnImport: boolean;
    schedules: Array<{ enabledOnImport: boolean; sourceEnabled: boolean }>;
  };
  assert.equal(workflow.enabledOnImport, false);
  assert.equal(workflow.schedules[0]?.enabledOnImport, false);
  assert.equal(workflow.schedules[0]?.sourceEnabled, true, 'source state may be shown only for review');

  const { stdout: fileList } = await execFileAsync('/usr/bin/unzip', ['-Z1', zipPath]);
  assert(!fileList.includes('..'));
  assert(!fileList.includes(emailSecret), 'PII must not leak through filenames');
  assert(!fileList.includes(pendingSlug), 'pending Skill path must be excluded');
  const exportedText = (await Promise.all(
    fileList.trim().split('\n').filter(Boolean).map((relative) => readFile(path.join(extractPath!, relative), 'utf8')),
  )).join('\n');
  assert(!exportedText.includes(secret), 'API key must be redacted from every exported file');
  assert(!exportedText.includes(emailSecret), 'email must be redacted from every exported file');
  assert(!exportedText.includes('short-credential-must-not-export'), 'short API credentials must be redacted by key name');
  assert(!exportedText.includes('local-vault-reference'), 'destination-local credential references must not export');
  assert(!exportedText.includes('raw transcript'), 'raw Builder transcript must be excluded');
  assert(!exportedText.includes('Pending content must not export'));

  const foreign = await app.inject({ method: 'GET', url: activeUrl, headers: { authorization: `Bearer ${foreignToken}` } });
  assert.equal(foreign.statusCode, 404, 'foreign member must not learn that the session exists');
  const scopedOwner = await app.inject({ method: 'GET', url: activeUrl, headers: { authorization: `Bearer ${scopedOwnerToken}` } });
  assert.equal(scopedOwner.statusCode, 404, 'scoped OAuth OWNER must not inherit cross-user FDE access');
  const fde = await app.inject({ method: 'GET', url: activeUrl, headers: { authorization: `Bearer ${trainerToken}` } });
  assert.equal(fde.statusCode, 200, 'unscoped FDE may export an inspected customer session');

  const ownerQueue = await app.inject({
    method: 'GET',
    url: '/api/agent-builder/evolution-queue',
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(ownerQueue.statusCode, 200);
  const ownerBuildIds = (ownerQueue.json().data as Array<{ id: string }>).map((row) => row.id);
  assert(ownerBuildIds.includes(ids.activeSession), 'owner portal must include its own ACTIVE build');
  assert(!ownerBuildIds.includes(ids.foreignSession), 'owner portal must exclude another account build');
  const trainerQueue = await app.inject({
    method: 'GET',
    url: '/api/agent-builder/evolution-queue',
    headers: { authorization: `Bearer ${trainerToken}` },
  });
  assert.equal(trainerQueue.statusCode, 200);
  const trainerBuildIds = (trainerQueue.json().data as Array<{ id: string }>).map((row) => row.id);
  assert(!trainerBuildIds.includes(ids.activeSession), 'FDE role must not widen the customer portal queue');
  assert(!trainerBuildIds.includes(ids.foreignSession), 'FDE role must remain account-scoped in the customer portal');
  const adminQueue = await app.inject({
    method: 'GET',
    url: '/api/agent-builder/admin/evolution-queue',
    headers: { authorization: `Bearer ${trainerToken}` },
  });
  assert.equal(adminQueue.statusCode, 200);
  const adminBuildIds = (adminQueue.json().data as Array<{ id: string }>).map((row) => row.id);
  assert(adminBuildIds.includes(ids.activeSession), 'FDE admin ledger must include customer builds');
  assert(adminBuildIds.includes(ids.foreignSession), 'FDE admin ledger must include other account builds');
  const foreignAdminQueue = await app.inject({
    method: 'GET',
    url: '/api/agent-builder/admin/evolution-queue',
    headers: { authorization: `Bearer ${foreignToken}` },
  });
  assert.equal(foreignAdminQueue.statusCode, 403, 'member must not access the FDE global ledger');
  const draft = await app.inject({
    method: 'GET',
    url: `/api/agent-builder/sessions/${ids.draftSession}/export`,
    headers: { authorization: `Bearer ${ownerToken}` },
  });
  assert.equal(draft.statusCode, 409, 'non-ACTIVE Builder session must fail closed');

  await prisma.skill.update({
    where: { id: ids.confirmedSkill },
    data: { assets: { templates: [{ path: '../../outside.txt', sourceName: 'outside.txt' }] } },
  });
  const traversal = await app.inject({ method: 'GET', url: activeUrl, headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(traversal.statusCode, 409, 'unsafe template paths must fail closed');
  assert.match(traversal.body, /unsafe template path/);

  const linkedTemplate = path.join(skillRoot, 'assets', 'templates', 'linked.txt');
  await symlink('/etc/hosts', linkedTemplate);
  await prisma.skill.update({
    where: { id: ids.confirmedSkill },
    data: { assets: { templates: [{ path: 'assets/templates/linked.txt', sourceName: 'linked.txt' }] } },
  });
  const symlinkEscape = await app.inject({ method: 'GET', url: activeUrl, headers: { authorization: `Bearer ${ownerToken}` } });
  assert.equal(symlinkEscape.statusCode, 409, 'symlinked template assets must fail closed');
  assert.match(symlinkEscape.body, /missing or unsafe/);

  await app.close();
  console.log('PASS agent package export: portable ZIP, redaction, governance, isolation and path safety');
} finally {
  await cleanup();
  await prisma.$disconnect();
}
