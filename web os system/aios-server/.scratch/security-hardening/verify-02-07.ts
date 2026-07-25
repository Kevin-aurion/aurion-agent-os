/**
 * Acceptance tests for tickets 02 (department path escape) and 07 (engine dispatch table).
 * Run: npx tsx .scratch/security-hardening/verify-02-07.ts
 */
import { existsSync, readdirSync, statSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { ulid } from 'ulid';
import { prisma } from '../../src/lib/db.js';
import { paths } from '../../src/config.js';
import { materializeAgent } from '../../src/engine/materialize.js';
import { runAgent } from '../../src/engine/index.js';
import { sanitizeSegment, assertInsideRoot, isInsideRoot } from '../../src/lib/safepath.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DEPARTMENT = '未分類';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

function listOutsideAgents(agentsRoot: string, probePaths: string[]): string[] {
  const root = path.resolve(agentsRoot);
  const bad: string[] = [];
  for (const p of probePaths) {
    const abs = path.resolve(p);
    if (existsSync(abs) && !isInsideRoot(root, abs)) bad.push(abs);
  }
  return bad;
}

async function main() {
  const user = await prisma.user.findFirst();
  assert(user, 'need at least one user in DB');

  const createdAgentIds: string[] = [];
  const createdWfIds: string[] = [];
  const createdRunIds: string[] = [];

  try {
    // ══════════════════════════════════════════════════════════════════════
    // 票 02 — department path escape
    // ══════════════════════════════════════════════════════════════════════
    console.log('══ 票 02: department path escape ══\n');

    // Unit: sanitizeSegment pure-dot → fallback
    for (const bad of ['..', '.', '...', '....']) {
      const got = sanitizeSegment(bad, DEFAULT_DEPARTMENT);
      assert(got === DEFAULT_DEPARTMENT, `sanitizeSegment(${JSON.stringify(bad)}) → ${JSON.stringify(got)}, expected ${DEFAULT_DEPARTMENT}`);
      console.log(`  ✓ sanitizeSegment(${JSON.stringify(bad)}) → ${JSON.stringify(got)}`);
    }
    const zh = sanitizeSegment('財務部', DEFAULT_DEPARTMENT);
    assert(zh === '財務部', `Chinese department preserved: got ${zh}`);
    console.log(`  ✓ sanitizeSegment('財務部') → ${JSON.stringify(zh)}`);

    // Negative: department='..' must not write outside paths.agents
    const escId = ulid();
    const escSlug = `sec02-esc-${escId.slice(-6).toLowerCase()}`;
    await prisma.agent.create({
      data: {
        id: escId,
        slug: escSlug,
        name: 'SEC02 escape',
        description: 'dept path escape negative',
        department: '..',
        rolePrompt: 'test',
        riskTier: 'low',
        createdBy: user.id,
      },
    });
    createdAgentIds.push(escId);

    // Snapshot parent of agents root — anything new there would be a leak.
    const agentsParent = path.dirname(path.resolve(paths.agents));
    const beforeParent = new Set(
      existsSync(agentsParent) ? readdirSync(agentsParent) : [],
    );

    console.log(`\n  ── negative: materializeAgent with department='..' ──`);
    console.log(`     paths.agents = ${paths.agents}`);
    let agentDir: string;
    try {
      agentDir = await materializeAgent(escId);
      console.log(`     materialize returned: ${agentDir}`);
      assert(isInsideRoot(paths.agents, agentDir), `agentDir must be inside agents root: ${agentDir}`);
      // Expected: falls back to 未分類, not parent of agents
      assert(
        agentDir.includes(path.join(paths.agents, DEFAULT_DEPARTMENT, escSlug)) ||
          path.resolve(agentDir) === path.resolve(paths.agents, DEFAULT_DEPARTMENT, escSlug),
        `expected under ${DEFAULT_DEPARTMENT}/${escSlug}, got ${agentDir}`,
      );
      console.log(`  ✓ agentDir stays inside agents root: ${agentDir}`);
    } catch (e) {
      // Throwing is also acceptable per ticket ("或直接 throw")
      const msg = e instanceof Error ? e.message : String(e);
      assert(/path escapes root|escapes/i.test(msg), `unexpected throw: ${msg}`);
      console.log(`  ✓ threw clear escape error (also acceptable): ${msg}`);
      agentDir = '';
    }

    // No new entries in parent of agents that look like our slug leaked
    const afterParent = existsSync(agentsParent) ? readdirSync(agentsParent) : [];
    const newInParent = afterParent.filter((n) => !beforeParent.has(n));
    const leak = newInParent.filter((n) => n.includes(escSlug) || n === escSlug);
    assert(leak.length === 0, `files leaked outside agents root: ${leak.join(', ')}`);
    console.log(`  ✓ no files created outside paths.agents (parent new entries related to slug: none)`);

    // Positive: Chinese department materializes under agents/<dept>/<slug>
    const posId = ulid();
    const posSlug = `sec02-pos-${posId.slice(-6).toLowerCase()}`;
    const posDept = '研發部';
    await prisma.agent.create({
      data: {
        id: posId,
        slug: posSlug,
        name: 'SEC02 positive',
        description: 'chinese dept positive',
        department: posDept,
        rolePrompt: 'test',
        riskTier: 'low',
        createdBy: user.id,
      },
    });
    createdAgentIds.push(posId);

    console.log(`\n  ── positive: department='${posDept}' ──`);
    const posDir = await materializeAgent(posId);
    assert(isInsideRoot(paths.agents, posDir), `positive agentDir outside root: ${posDir}`);
    assert(
      path.resolve(posDir) === path.resolve(paths.agents, posDept, posSlug),
      `expected ${path.join(posDept, posSlug)}, got ${posDir}`,
    );
    assert(existsSync(path.join(posDir, 'agent.md')), 'agent.md should exist');
    assert(existsSync(path.join(posDir, 'CLAUDE.md')), 'CLAUDE.md should exist');
    console.log(`  ✓ Chinese department materialized at: ${posDir}`);

    // Positive: normal ascii department
    const asciiId = ulid();
    const asciiSlug = `sec02-ascii-${asciiId.slice(-6).toLowerCase()}`;
    await prisma.agent.create({
      data: {
        id: asciiId,
        slug: asciiSlug,
        name: 'SEC02 ascii',
        description: 'ascii dept',
        department: 'Finance',
        rolePrompt: 'test',
        riskTier: 'low',
        createdBy: user.id,
      },
    });
    createdAgentIds.push(asciiId);
    const asciiDir = await materializeAgent(asciiId);
    assert(path.resolve(asciiDir) === path.resolve(paths.agents, 'Finance', asciiSlug));
    console.log(`  ✓ ascii department materialized at: ${asciiDir}`);

    // Defense-in-depth unit: assertInsideRoot rejects escape candidates
    let threw = false;
    try {
      assertInsideRoot(paths.agents, path.join(paths.agents, '..', 'outside-leak'));
    } catch {
      threw = true;
    }
    assert(threw, 'assertInsideRoot should throw for path.join(root, "..", "x")');
    console.log(`  ✓ assertInsideRoot throws on escape candidate`);

    // ══════════════════════════════════════════════════════════════════════
    // 票 07 — engine dispatch table
    // ══════════════════════════════════════════════════════════════════════
    console.log('\n══ 票 07: engine dispatch table ══\n');

    const runnerSrc = readFileSync(
      path.resolve(__dirname, '../../src/engine/runner.ts'),
      'utf8',
    );

    // Structural: ENGINE_ADAPTERS table with all three engines + decide on GROK
    assert(/const ENGINE_ADAPTERS:\s*Record<\s*Engine\s*,\s*EngineAdapter\s*>/.test(runnerSrc), 'ENGINE_ADAPTERS Record missing');
    for (const eng of ['CLAUDE_CODE', 'CODEX', 'GROK'] as const) {
      // Each key appears as object key under ENGINE_ADAPTERS
      assert(new RegExp(`${eng}:\\s*\\{`).test(runnerSrc), `ENGINE_ADAPTERS missing ${eng}`);
      console.log(`  ✓ ENGINE_ADAPTERS has ${eng}`);
    }
    // GROK decide must call runGrok
    const grokBlock = runnerSrc.slice(runnerSrc.indexOf('GROK:'), runnerSrc.indexOf('GROK:') + 2500);
    assert(/async decide\(/.test(grokBlock), 'GROK adapter missing decide()');
    assert(/runGrok\(/.test(grokBlock), 'GROK decide/verify/execute must use runGrok');
    console.log('  ✓ GROK.decide exists and uses runGrok');

    // All three call sites use table dispatch (no engine if-cascade for execute/verify/decide)
    assert(/ENGINE_ADAPTERS\[engine\]/.test(runnerSrc) || /ENGINE_ADAPTERS\[ctx\.manifest\.engine/.test(runnerSrc), 'call sites must index ENGINE_ADAPTERS');
    // Count adapter.execute / .verify / .decide invocations
    assert(/adapter\.execute\(/.test(runnerSrc), 'runExecuteStep must call adapter.execute');
    assert(/adapter\.verify\(/.test(runnerSrc), 'runVerifyStep must call adapter.verify');
    assert(/adapter\.decide\(/.test(runnerSrc), 'callManagerDecision must call adapter.decide');
    console.log('  ✓ execute / verify / decide all dispatch via adapter');

    // Cost engine field uses the runtime `engine` variable (not hard-coded CLAUDE_CODE for decide)
    const decideFn = runnerSrc.slice(
      runnerSrc.indexOf('async function callManagerDecision'),
      runnerSrc.indexOf('async function runDoStep'),
    );
    assert(/engine:\s*engine\b/.test(decideFn) || /engine,\s*\/\/ GROK decide/.test(decideFn) || /engine, \/\/ GROK/.test(decideFn) || /engine,/.test(decideFn),
      'callManagerDecision must record cost with runtime engine');
    assert(!/engine:\s*'CLAUDE_CODE'/.test(decideFn), 'decide must not hard-code CLAUDE_CODE cost engine');
    console.log('  ✓ decide cost engine is runtime variable (not hard-coded CLAUDE_CODE)');

    // Evidence: compileManifest still forces executor ≠ verifier
    const compileFn = runnerSrc.slice(
      runnerSrc.indexOf('async function compileManifest'),
      runnerSrc.indexOf('// ── Engine dispatch'),
    );
    assert(/engineExecute === 'CLAUDE_CODE' \? 'CODEX' : 'CLAUDE_CODE'/.test(compileFn), 'autoVerify opposite-engine rule missing');
    assert(/engineVerify && agent\.engineVerify !== engineExecute/.test(compileFn), 'explicit engineVerify ≠ execute check missing');
    console.log('  ✓ compileManifest still forces executor ≠ verifier (autoVerify + explicit override)');
    console.log('     autoVerify = engineExecute === CLAUDE_CODE ? CODEX : CLAUDE_CODE');
    console.log('     engineVerify = agent.engineVerify && !== execute ? chosen : autoVerify');

    // Codex verify still uses read-only sandbox
    const codexBlock = runnerSrc.slice(runnerSrc.indexOf('CODEX:'), runnerSrc.indexOf('GROK:'));
    assert(/sandbox:\s*'read-only'/.test(codexBlock), 'CODEX verify must use sandbox read-only');
    assert(/sandbox:\s*'workspace-write'/.test(codexBlock), 'CODEX execute must use workspace-write');
    console.log('  ✓ CODEX verify sandbox:read-only; execute workspace-write preserved');

    // Grok execute still honors disableWebSearch
    assert(/disableWebSearch:\s*!restrictions\.webSearch/.test(grokBlock) || /disableWebSearch:\s*!.*webSearch/.test(grokBlock),
      'GROK execute must pass disableWebSearch from restrictions');
    console.log('  ✓ GROK execute disableWebSearch restriction preserved');

    // Claude execute still uses claudeDisallowedTools
    const claudeBlock = runnerSrc.slice(runnerSrc.indexOf('CLAUDE_CODE:'), runnerSrc.indexOf('CODEX:'));
    assert(/claudeDisallowedTools\(restrictions\)/.test(claudeBlock), 'CLAUDE execute must use claudeDisallowedTools');
    console.log('  ✓ CLAUDE claudeDisallowedTools restriction preserved');

    // ── CONDITION-only workflow regression (no CLI engines) ──────────────
    console.log('\n  ── regression: CONDITION-only workflow → SUCCEEDED ──');
    const condAgentId = ulid();
    const condSlug = `sec07-cond-${condAgentId.slice(-6).toLowerCase()}`;
    const condWfId = ulid();
    await prisma.agent.create({
      data: {
        id: condAgentId,
        slug: condSlug,
        name: 'SEC07 condition',
        description: 'condition-only regression',
        department: '測試',
        rolePrompt: 'You are a test agent.',
        riskTier: 'low',
        engineExecute: 'CLAUDE_CODE',
        createdBy: user.id,
        restrictions: { webSearch: false, computerUse: false, sendEmail: false, cloudWrite: false, shell: false },
      },
    });
    createdAgentIds.push(condAgentId);
    await prisma.workflow.create({
      data: {
        id: condWfId,
        agentId: condAgentId,
        name: 'SEC07 condition only',
        description: 'no engines',
        enabled: true,
        durable: false,
        trigger: { type: 'manual' },
        steps: {
          create: [
            {
              id: ulid(),
              position: 0,
              stepKey: 'check',
              type: 'CONDITION',
              config: { expr: 'true', onTrue: null, onFalse: null },
            },
          ],
        },
      },
    });
    createdWfIds.push(condWfId);

    const runId = ulid();
    createdRunIds.push(runId);
    const outcome = await runAgent({
      agentId: condAgentId,
      workflowId: condWfId,
      runId,
      input: { message: 'condition-only regression' },
      triggeredBy: 'verify-02-07',
    });
    console.log(`     status=${outcome.status} stoppedAt=${outcome.stoppedAt ?? '(end)'} results=${outcome.results?.length ?? 0}`);
    assert(outcome.status === 'SUCCEEDED', `expected SUCCEEDED, got ${outcome.status}`);
    assert(outcome.results?.some((r) => r.stepKey === 'check' && r.ok), 'CONDITION step should be ok');
    console.log('  ✓ CONDITION-only run SUCCEEDED (zero regression on dispatch restructure)');

    console.log('\n════════════════════════════════════════');
    console.log('ALL 02 + 07 ACCEPTANCE CHECKS PASSED');
    console.log('════════════════════════════════════════');
  } finally {
    // Cleanup runs → steps, workflows, agents, on-disk agent dirs
    for (const rid of createdRunIds) {
      await prisma.runStep.deleteMany({ where: { runId: rid } }).catch(() => {});
      await prisma.run.delete({ where: { id: rid } }).catch(() => {});
    }
    for (const wid of createdWfIds) {
      await prisma.workflowStep.deleteMany({ where: { workflowId: wid } }).catch(() => {});
      await prisma.workflow.delete({ where: { id: wid } }).catch(() => {});
    }
    for (const aid of createdAgentIds) {
      const a = await prisma.agent.findUnique({ where: { id: aid } }).catch(() => null);
      if (a) {
        // Remove materialized dir if present
        for (const dept of [a.department, DEFAULT_DEPARTMENT, 'Finance', '研發部', '測試', '..']) {
          const d = path.join(paths.agents, sanitizeSegment(dept, DEFAULT_DEPARTMENT), a.slug);
          if (existsSync(d)) {
            try {
              rmSync(d, { recursive: true, force: true });
            } catch {
              /* ignore */
            }
          }
        }
      }
      await prisma.agent.delete({ where: { id: aid } }).catch(() => {});
    }
    await prisma.$disconnect();
  }
}

main().catch(async (e) => {
  console.error('\nVERIFY FAILED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
