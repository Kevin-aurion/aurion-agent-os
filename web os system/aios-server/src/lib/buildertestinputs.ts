import path from 'node:path';

export type BuilderTestInputKind = 'FILE' | 'TEXT';

export type BuilderTestInputRequirement = {
  key: string;
  label: string;
  description: string;
  kind: BuilderTestInputKind;
  required: boolean;
  acceptedExtensions: string[];
  minFiles: number;
  maxFiles: number;
};

export type BuilderTestFixture = {
  id: string;
  requirementKey: string;
  name: string;
  mimeType: string;
  size: number;
  content: string;
  uploadedAt: string;
};

export type BuilderTestData = {
  version: 1;
  manualText: Record<string, string>;
  fixtures: BuilderTestFixture[];
};

export type BuilderTestInputStatus = {
  requirements: Array<BuilderTestInputRequirement & {
    suppliedCount: number;
    supplied: boolean;
    files: Array<Pick<BuilderTestFixture, 'id' | 'name' | 'mimeType' | 'size' | 'uploadedAt'>>;
  }>;
  complete: boolean;
  missingRequiredKeys: string[];
};

const GLOBAL_SAFE_EXTENSIONS = new Set([
  '.srt', '.vtt', '.txt', '.md', '.pdf', '.docx', '.csv', '.tsv', '.xlsx', '.xls',
  '.json', '.yaml', '.yml', '.html',
]);

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function normalizeExtension(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return null;
  const extension = trimmed.startsWith('.') ? trimmed : `.${trimmed}`;
  return GLOBAL_SAFE_EXTENSIONS.has(extension) ? extension : null;
}

function safeKey(value: unknown, index: number): string {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 64);
  return normalized || `input_${index + 1}`;
}

export function normalizeTestInputRequirements(value: unknown): BuilderTestInputRequirement[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const requirements: BuilderTestInputRequirement[] = [];
  for (const [index, item] of value.slice(0, 12).entries()) {
    const row = asObject(item);
    if (!row) continue;
    let key = safeKey(row.key, index);
    if (seen.has(key)) key = `${key}_${index + 1}`;
    seen.add(key);
    const kind: BuilderTestInputKind = row.kind === 'TEXT' ? 'TEXT' : 'FILE';
    const required = row.required !== false;
    const extensions = kind === 'FILE' && Array.isArray(row.acceptedExtensions)
      ? [...new Set(row.acceptedExtensions.map(normalizeExtension).filter((ext): ext is string => Boolean(ext)))].slice(0, 12)
      : [];
    const minDefault = required ? 1 : 0;
    const minFiles = kind === 'FILE'
      ? Math.max(minDefault, Math.min(10, Number(row.minFiles ?? minDefault) || 0))
      : 0;
    const maxFiles = kind === 'FILE'
      ? Math.max(minFiles || 1, Math.min(10, Number(row.maxFiles ?? 1) || 1))
      : 0;
    requirements.push({
      key,
      label: String(row.label ?? `測試資料 ${index + 1}`).trim().slice(0, 120) || `測試資料 ${index + 1}`,
      description: String(row.description ?? '').trim().slice(0, 600),
      kind,
      required,
      acceptedExtensions: extensions.length || kind === 'TEXT' ? extensions : ['.txt'],
      minFiles,
      maxFiles,
    });
  }
  return requirements;
}

export function inferTestInputRequirements(input: {
  identityName?: string;
  skills?: Array<{ inputs?: string[] }>;
  testIdeas?: Array<{ name?: string; input?: string; expected?: string }>;
}): BuilderTestInputRequirement[] {
  const text = [
    input.identityName ?? '',
    ...(input.skills ?? []).flatMap((skill) => skill.inputs ?? []),
    ...(input.testIdeas ?? []).flatMap((testIdea) => [testIdea.name ?? '', testIdea.input ?? '']),
  ].join('\n');
  const result: BuilderTestInputRequirement[] = [];
  const mentionsTranscript = /(?:srt|vtt|逐字稿|transcript)/i.test(text);
  const mentionsRequirements = /(?:需求文件|需求書|brief|requirements?\s*(?:document|file)?|pdf)/i.test(text);
  if (mentionsTranscript) {
    result.push({
      key: 'meeting_transcript',
      label: '會議逐字稿',
      description: '請上傳一份可代表真實工作情境的會議逐字稿；SRT 為建議格式。',
      kind: 'FILE',
      required: true,
      acceptedExtensions: ['.srt', '.vtt', '.txt'],
      minFiles: 1,
      maxFiles: 1,
    });
  }
  if (mentionsRequirements) {
    const optional = /(?:選填|可選|optional)/i.test(text);
    result.push({
      key: 'requirement_documents',
      label: '需求文件',
      description: optional ? '如有額外需求文件可一併提供，未提供仍可測試。' : '請提供本次任務所需的需求文件。',
      kind: 'FILE',
      required: !optional && !mentionsTranscript,
      acceptedExtensions: ['.pdf', '.docx', '.md', '.txt'],
      minFiles: !optional && !mentionsTranscript ? 1 : 0,
      maxFiles: 3,
    });
  }
  return result.length > 0 ? result : [{
    key: 'manual_input',
    label: '測試內容',
    description: '請輸入一筆可代表真實工作情境的匿名化測試資料。',
    kind: 'TEXT',
    required: true,
    acceptedExtensions: [],
    minFiles: 0,
    maxFiles: 0,
  }];
}

export function parseBuilderTestData(value: unknown): BuilderTestData {
  const obj = asObject(value);
  const fixtures = Array.isArray(obj?.fixtures)
    ? obj.fixtures.slice(0, 30).map((item) => {
        const row = asObject(item);
        if (!row) return null;
        const fixture: BuilderTestFixture = {
          id: String(row.id ?? '').slice(0, 80),
          requirementKey: safeKey(row.requirementKey, 0),
          name: path.basename(String(row.name ?? 'fixture')).replace(/[\r\n]/g, '').slice(0, 240),
          mimeType: String(row.mimeType ?? 'application/octet-stream').slice(0, 160),
          size: Math.max(0, Number(row.size ?? 0) || 0),
          content: typeof row.content === 'string' ? row.content : '',
          uploadedAt: String(row.uploadedAt ?? ''),
        };
        return fixture.id && fixture.content ? fixture : null;
      }).filter((item): item is BuilderTestFixture => Boolean(item))
    : [];
  const manualRaw = asObject(obj?.manualText);
  const manualText = Object.fromEntries(
    Object.entries(manualRaw ?? {})
      .filter(([, text]) => typeof text === 'string')
      .slice(0, 12)
      .map(([key, text], index) => [safeKey(key, index), String(text).slice(0, 30_000)]),
  );
  return { version: 1, fixtures, manualText };
}

export function getTestInputStatus(
  requirements: BuilderTestInputRequirement[],
  data: BuilderTestData,
): BuilderTestInputStatus {
  const statuses = requirements.map((requirement) => {
    const fixtures = data.fixtures.filter((fixture) => fixture.requirementKey === requirement.key);
    const textValue = data.manualText[requirement.key]?.trim() ?? '';
    const suppliedCount = requirement.kind === 'FILE' ? fixtures.length : (textValue ? 1 : 0);
    const supplied = suppliedCount >= (requirement.kind === 'FILE' ? requirement.minFiles : 1);
    return {
      ...requirement,
      suppliedCount,
      supplied,
      files: fixtures.map(({ id, name, mimeType, size, uploadedAt }) => ({ id, name, mimeType, size, uploadedAt })),
    };
  });
  const missingRequiredKeys = statuses
    .filter((requirement) => requirement.required && !requirement.supplied)
    .map((requirement) => requirement.key);
  return { requirements: statuses, complete: missingRequiredKeys.length === 0, missingRequiredKeys };
}

export function assertFixtureExtension(requirement: BuilderTestInputRequirement, filename: string): void {
  const extension = path.extname(path.basename(filename)).toLowerCase();
  if (!GLOBAL_SAFE_EXTENSIONS.has(extension) || !requirement.acceptedExtensions.includes(extension)) {
    throw new Error(`檔案格式不支援；${requirement.label}僅接受 ${requirement.acceptedExtensions.join('、')}`);
  }
}
