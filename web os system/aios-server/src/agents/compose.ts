// Text → full AI employee: stub agent immediately, then blueprint + fan-out
// skill builds and workflow drafts in the background. Never auto-confirms
// skills, never mounts them, never enables workflows (governance gates stay).
import { z } from 'zod';
import { ulid } from 'ulid';
import { prisma } from '../lib/db.js';
import { draftWithEngine, looseParseJson, type DraftEngine } from '../engine/draft.js';
import { parseRestrictions } from '../engine/restrictions.js';
import { buildSkillFromRequirement } from '../skills/build.js';
import { composeWorkflowForAgent } from '../workflow/compose.js';
import { slugify } from '../lib/slug.js';

const EngineEnum = z.enum(['CLAUDE_CODE', 'CODEX', 'GROK']);

const ReqItemSchema = z.object({ requirement: z.string().min(1) }).passthrough();

/** Coerce a skill/workflow list: drop invalid items rather than fail the whole blueprint. */
function coerceReqList(raw: unknown): { requirement: string }[] {
  if (!Array.isArray(raw)) return [];
  const out: { requirement: string }[] = [];
  for (const item of raw) {
    if (typeof item === 'string' && item.trim()) {
      out.push({ requirement: item.trim() });
      continue;
    }
    const p = ReqItemSchema.safeParse(item);
    if (p.success) out.push({ requirement: p.data.requirement.trim() });
  }
  return out;
}

const BlueprintSchema = z.object({
  name: z.string().min(1).optional(),
  department: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  rolePrompt: z.string().min(1).optional(),
  restrictions: z.unknown().optional(),
  engineExecute: z.string().optional(),
  skills: z.unknown().optional(),
  workflows: z.unknown().optional(),
});

function buildBlueprintPrompt(requirement: string): string {
  return [
    'You are designing an AI employee (agent) for a local multi-agent workplace system.',
    'Output STRICT JSON only — no markdown fences, no commentary.',
    '',
    '## User requirement',
    requirement,
    '',
    '## Output shape (STRICT JSON)',
    '{',
    '  "name": "財務長 Agent",',
    '  "department": "財務",',
    '  "description": "AR/AP 帳款監控與報表",',
    '  "rolePrompt": "你是嚴謹的財務助理…（完整角色設定，繁體中文）",',
    '  "restrictions": {',
    '    "webSearch": false,',
    '    "computerUse": false,',
    '    "sendEmail": false,',
    '    "cloudWrite": true,',
    '    "shell": true,',
    '    "cloudEmbedding": true,',
    '    "notes": "只依公司提供的資料回答"',
    '  },',
    '  "engineExecute": "CLAUDE_CODE",',
    '  "skills": [',
    '    { "requirement": "讀取指定資料夾的 AR Excel，篩出逾期>30天的帳款並彙整" }',
    '  ],',
    '  "workflows": [',
    '    { "requirement": "每天早上9點掃描應收帳款，把逾期>30天做成報表發到財務組LINE，金額不對要擋下重算" }',
    '  ]',
    '}',
    '',
    '## Field rules',
    '- name: short display name in Traditional Chinese when the user writes in Chinese.',
    '- department: short department label (e.g. 財務, 人資, 業務); default 未分類 if unclear.',
    '- description: one-line summary of what this employee does.',
    '- rolePrompt: full role setting in Traditional Chinese — persona, duties, tone, boundaries. Be specific and usable as a system role prompt.',
    '- restrictions: booleans for webSearch, computerUse, sendEmail, cloudWrite, shell, cloudEmbedding; optional notes string. Choose the least privilege needed for the role.',
    '- engineExecute: one of CLAUDE_CODE | CODEX | GROK (prefer CLAUDE_CODE unless coding-heavy).',
    '- skills: 0–5 items; each requirement is a concrete skill the employee needs (not already generic chat).',
    '- workflows: 0–5 items; each requirement describes an end-to-end workflow (trigger + steps + verify if money/numbers).',
    '- Prefer 1–3 skills and 1–2 workflows unless the requirement clearly needs more.',
    '- Output ONLY the JSON object.',
  ].join('\n');
}

/**
 * Create a stub agent immediately, then in the background draft a blueprint
 * and fan out skill builds + workflow drafts. Skills stay unconfirmed /
 * unmounted; workflows stay enabled=false.
 */
export async function composeAgentFromRequirement(params: {
  requirement: string;
  engine: DraftEngine;
  createdBy: string;
}): Promise<{ agentId: string }> {
  const { requirement, engine, createdBy } = params;
  const firstLine = (requirement.split(/\r?\n/)[0] ?? '').slice(0, 40).trim() || '新員工';
  const agentId = ulid();

  await prisma.agent.create({
    data: {
      id: agentId,
      slug: slugify(firstLine),
      name: firstLine,
      description: firstLine,
      department: '未分類',
      rolePrompt: requirement,
      createdBy,
    },
  });

  void (async () => {
    try {
      const raw = await draftWithEngine(engine, buildBlueprintPrompt(requirement));
      const parsed = raw ? looseParseJson(raw) : undefined;
      const bp = BlueprintSchema.safeParse(parsed && typeof parsed === 'object' ? parsed : {});
      // Missing fields fall back to the stub agent row already written.
      const data = bp.success ? bp.data : {};
      const skillReqs = coerceReqList(data.skills);
      const wfReqs = coerceReqList(data.workflows);

      const update: {
        name?: string;
        department?: string;
        description?: string;
        rolePrompt?: string;
        restrictions?: object;
        engineExecute?: 'CLAUDE_CODE' | 'CODEX' | 'GROK';
      } = {};

      if (typeof data.name === 'string' && data.name.trim()) update.name = data.name.trim().slice(0, 80);
      if (typeof data.department === 'string' && data.department.trim()) {
        update.department = data.department.trim().slice(0, 80);
      }
      if (typeof data.description === 'string' && data.description.trim()) {
        update.description = data.description.trim().slice(0, 500);
      }
      if (typeof data.rolePrompt === 'string' && data.rolePrompt.trim()) {
        update.rolePrompt = data.rolePrompt.trim();
      }
      if (data.restrictions != null) {
        update.restrictions = parseRestrictions(data.restrictions) as object;
      }
      const eng = EngineEnum.safeParse(data.engineExecute);
      if (eng.success) update.engineExecute = eng.data;

      if (Object.keys(update).length > 0) {
        await prisma.agent.update({ where: { id: agentId }, data: update }).catch((e) => {
          console.error('[agents/compose] agent update failed', { agentId, err: e });
        });
      }

      for (const s of skillReqs) {
        try {
          await buildSkillFromRequirement({
            requirement: s.requirement,
            engine,
            assets: { composedForAgentId: agentId },
          });
        } catch (e) {
          console.error('[agents/compose] skill build failed', { agentId, err: e });
        }
      }

      for (const w of wfReqs) {
        try {
          await composeWorkflowForAgent({
            agentId,
            requirement: w.requirement,
            engine,
            createdBy,
          });
        } catch (e) {
          console.error('[agents/compose] workflow compose failed', { agentId, err: e });
        }
      }
    } catch (e) {
      console.error('[agents/compose] background blueprint failed', { agentId, err: e });
    }
  })();

  return { agentId };
}
