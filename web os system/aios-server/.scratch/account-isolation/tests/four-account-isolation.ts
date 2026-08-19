import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { ulid } from 'ulid';
import { config, paths } from '../../../src/config.js';
import { signAccess } from '../../../src/lib/auth.js';
import { prisma } from '../../../src/lib/db.js';

const baseUrl = process.env.AIOS_TEST_BASE_URL || 'https://aurion-aios.lazyoffice.app';
const handoffPath = process.env.AIOS_ACCOUNT_HANDOFF_PATH
  || '/Users/kevin/Documents/Aurion AIOS Private/客戶帳號-2026-08-08.txt';
const ownerEmail = process.env.AIOS_OWNER_EMAIL || 'fde@aios.test';
const customerEmailDomain = process.env.AIOS_CUSTOMER_EMAIL_DOMAIN || 'aurion-group.com';
const marker = `isolation-${Date.now()}`;

type TokenIdentity = {
  id: string;
  email: string;
  role: string;
  webToken: string;
  pluginToken: string;
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function request(
  path: string,
  init: RequestInit = {},
  expectedStatus = 200,
): Promise<any> {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  assert(
    response.status === expectedStatus,
    `${init.method ?? 'GET'} ${path}: expected ${expectedStatus}, got ${response.status}`,
  );
  return body;
}

function bearer(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

function parseCredentials(contents: string): Map<string, string> {
  const result = new Map<string, string>();
  const blocks = contents.split(/\n\s*\n/);
  for (const block of blocks) {
    const email = block.match(/^帳號：(.+)$/m)?.[1]?.trim();
    const password = block.match(/^密碼：(.+)$/m)?.[1]?.trim();
    if (email && password) result.set(email, password);
  }
  return result;
}

async function main() {
  const accountEmails = [
    ownerEmail,
    `vincent@${customerEmailDomain}`,
    `lauren@${customerEmailDomain}`,
    `kate@${customerEmailDomain}`,
  ];
  const memberEmails = accountEmails.slice(1);
  const credentials = parseCredentials(await readFile(handoffPath, 'utf8'));
  const identities: TokenIdentity[] = [];
  const agentIds: string[] = [];
  const builderSessionIds: string[] = [];
  const generatedSkillIds: string[] = [];
  const generatedSkillSlugs: string[] = [];

  try {
    // Real password login for every newly provisioned customer identity.
    for (const email of memberEmails) {
      const password = credentials.get(email);
      assert(password, `missing handoff credential for ${email}`);
      assert(password.length === 16, `${email} password is not exactly 16 characters`);
      const login = await request('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password, client: 'four-account-isolation-test' }),
      });
      assert(login?.success && login.data?.user?.email === email, `login identity mismatch for ${email}`);
      assert(login.data.user.role === 'MEMBER', `${email} is not MEMBER`);
      identities.push({
        id: login.data.user.id,
        email,
        role: 'MEMBER',
        webToken: login.data.access,
        pluginToken: await signAccess({
          sub: login.data.user.id,
          email,
          role: 'MEMBER',
          scope: 'aios:agent-builder',
          audience: config.remoteMcp.resourceUrl,
        }),
      });
    }

    const kevin = await prisma.user.findFirst({
      where: { email: accountEmails[0], deletedAt: null },
      select: { id: true, email: true, role: true },
    });
    assert(kevin?.role === 'OWNER', 'Kevin must remain OWNER');
    identities.unshift({
      id: kevin.id,
      email: kevin.email,
      role: kevin.role,
      webToken: await signAccess({ sub: kevin.id, email: kevin.email, role: kevin.role }),
      // Remote MCP deliberately downgrades FDE authority while retaining sub.
      pluginToken: await signAccess({
        sub: kevin.id,
        email: kevin.email,
        role: 'MEMBER',
        scope: 'aios:agent-builder',
        audience: config.remoteMcp.resourceUrl,
      }),
    });

    // The exact scoped token shape used by Claude/GPT must resolve to the
    // correct account and remain MEMBER-effective, including Kevin's plugin.
    for (const identity of identities) {
      const me = await request('/api/auth/me', { headers: bearer(identity.pluginToken) });
      assert(me?.data?.id === identity.id, `plugin sub mismatch for ${identity.email}`);
      assert(me.data.role === 'MEMBER', `plugin privilege was not downgraded for ${identity.email}`);
    }

    // Create four non-effective external build records through the same API
    // boundary used by the Claude/GPT plugin.
    for (const identity of identities) {
      const created = await request('/api/agent-builder/external/sessions', {
        method: 'POST',
        headers: bearer(identity.pluginToken),
        body: JSON.stringify({
          source: 'CHATGPT',
          initialRequest: `${marker}: 建立 ${identity.email} 專屬測試 Agent`,
          externalConversationId: `${marker}-${identity.id}`,
          requestedAgentName: `${marker}-${identity.email}`,
        }),
      });
      const sessionId = created?.data?.session?.id;
      assert(sessionId, `builder session missing for ${identity.email}`);
      builderSessionIds.push(sessionId);
    }

    for (let i = 0; i < identities.length; i += 1) {
      const identity = identities[i]!;
      const ownSessionId = builderSessionIds[i]!;
      const foreignSessionId = builderSessionIds[(i + 1) % identities.length]!;
      const listed = await request('/api/agent-builder/sessions', {
        headers: bearer(identity.pluginToken),
      });
      const ids = (listed?.data ?? []).map((row: { id: string }) => row.id);
      assert(ids.includes(ownSessionId), `${identity.email} cannot see its own build`);
      assert(!ids.includes(foreignSessionId), `${identity.email} can list a foreign build`);
      await request(
        `/api/agent-builder/sessions/${foreignSessionId}`,
        { headers: bearer(identity.pluginToken) },
        404,
      );
    }

    // Create one disposable live Agent per identity to verify workbench/runtime
    // visibility. These rows are deleted in finally and never execute.
    for (const identity of identities) {
      const id = ulid();
      agentIds.push(id);
      await prisma.agent.create({
        data: {
          id,
          slug: `${marker}-${identity.id}`.toLowerCase(),
          name: `${marker}-${identity.email}`,
          description: 'temporary ownership isolation test',
          department: 'QA',
          rolePrompt: 'Never execute; isolation fixture only.',
          restrictions: {
            webSearch: false,
            computerUse: false,
            sendEmail: false,
            cloudWrite: false,
            shell: false,
          },
          status: 'PAUSED',
          createdBy: identity.id,
        },
      });
    }

    for (let i = 1; i < identities.length; i += 1) {
      const identity = identities[i]!;
      const ownAgentId = agentIds[i]!;
      const foreignAgentId = agentIds[i === identities.length - 1 ? 1 : i + 1]!;
      const listed = await request('/api/agents', { headers: bearer(identity.webToken) });
      const ids = (listed?.data ?? []).map((row: { id: string }) => row.id);
      assert(ids.includes(ownAgentId), `${identity.email} cannot list its own Agent`);
      assert(!ids.includes(foreignAgentId), `${identity.email} can list a foreign Agent`);
      await request(`/api/agents/${ownAgentId}`, { headers: bearer(identity.webToken) });
      await request(`/api/agents/${foreignAgentId}`, { headers: bearer(identity.webToken) }, 404);
      await request(`/api/agents/${foreignAgentId}/cost`, { headers: bearer(identity.webToken) }, 404);
      await request(`/api/agents/${foreignAgentId}/workflows`, { headers: bearer(identity.webToken) }, 404);
      await request(`/api/agents/${foreignAgentId}/conversations`, { headers: bearer(identity.webToken) }, 404);
    }

    // Kevin's ordinary workbench is also owner-scoped, while an explicit FDE
    // management query can inspect all four customers.
    const kevinIdentity = identities[0]!;
    const kevinMine = await request('/api/agents', { headers: bearer(kevinIdentity.webToken) });
    const mineIds = (kevinMine?.data ?? []).map((row: { id: string }) => row.id);
    assert(mineIds.includes(agentIds[0]!), 'Kevin workbench cannot see Kevin Agent');
    assert(!mineIds.includes(agentIds[1]!), 'Kevin workbench leaked another customer Agent');
    const fdeAll = await request('/api/agents?scope=all', { headers: bearer(kevinIdentity.webToken) });
    const allIds = (fdeAll?.data ?? []).map((row: { id: string }) => row.id);
    for (const agentId of agentIds) {
      assert(allIds.includes(agentId), 'FDE all-scope is missing a customer Agent');
    }
    await request('/api/agents?scope=all', { headers: bearer(identities[1]!.webToken) }, 403);

    // Exercise the real FDE approval compiler, not merely fixture ownership:
    // the customer owns the result while Kevin remains the approving actor.
    const attributionSessionId = ulid();
    builderSessionIds.push(attributionSessionId);
    await prisma.agentBuildSession.create({
      data: {
        id: attributionSessionId,
        userId: identities[1]!.id,
        status: 'AWAITING_FDE',
        strategy: 'create',
        transcript: [],
        brief: {
          objective: `${marker} FDE attribution check`,
          inputs: 'manual fixture',
          outputs: 'draft only',
          process: 'read, summarize, stop',
          permissions: 'no external actions',
        },
        plan: {
          summary: 'ownership attribution check',
          strategyRecommendation: 'create',
          reuseCandidates: [],
          skillMatches: [],
          connections: [],
          gaps: [],
          proposedAgentName: `${marker}-compiled`,
          proposedSkillName: `${marker}-skill`,
          privilegeNote: 'least privilege',
        },
        progress: { answeredKeys: ['objective'], currentKey: null, total: 1 },
      },
    });
    const approved = await request(
      `/api/agent-builder/sessions/${attributionSessionId}/approve-build`,
      { method: 'POST', headers: bearer(kevinIdentity.webToken), body: '{}' },
    );
    const compiledAgentId = approved?.data?.session?.builtAgentId;
    const compiledSkillIds = approved?.data?.session?.draftSkillIds ?? [];
    assert(compiledAgentId, 'FDE approval did not create an Agent');
    agentIds.push(compiledAgentId);
    generatedSkillIds.push(...compiledSkillIds);
    const compiled = await prisma.agent.findUnique({ where: { id: compiledAgentId } });
    assert(compiled?.createdBy === identities[1]!.id, 'FDE approval attributed Agent to Kevin instead of Vincent');
    const generatedSkills = await prisma.skill.findMany({
      where: { id: { in: compiledSkillIds } },
      select: { slug: true },
    });
    generatedSkillSlugs.push(...generatedSkills.map((skill) => skill.slug));
    await request(`/api/agents/${compiledAgentId}`, { headers: bearer(identities[1]!.webToken) });
    await request(`/api/agents/${compiledAgentId}`, { headers: bearer(identities[2]!.webToken) }, 404);

    console.log(JSON.stringify({
      passed: true,
      passwordLogins: 3,
      pluginIdentitiesChecked: 4,
      isolatedBuilderSessions: 4,
      isolatedAgents: 4,
      crossAccountNegativeChecks: 21,
      fdeAllScopeChecked: true,
      fdeApprovalOwnershipChecked: true,
    }));
  } finally {
    if (builderSessionIds.length) {
      await prisma.agentBuildSession.deleteMany({ where: { id: { in: builderSessionIds } } });
    }
    if (agentIds.length) {
      await prisma.agent.deleteMany({ where: { id: { in: agentIds } } });
    }
    if (generatedSkillIds.length) {
      await prisma.skill.deleteMany({ where: { id: { in: generatedSkillIds } } });
    }
    await Promise.all(
      generatedSkillSlugs.map((slug) => rm(path.join(paths.skills, slug), { recursive: true, force: true })),
    );
    await prisma.session.updateMany({
      where: { client: 'four-account-isolation-test', revokedAt: null },
      data: { revokedAt: new Date() },
    });
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
