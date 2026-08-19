/**
 * Ticket 08 — Voice transcription (OpenAI Whisper).
 * Run: npx tsx .scratch/agent-training-governance/tests/t08.test.ts
 *
 * Seams:
 * 1. Real POST /api/voice/transcribe with short audio → non-empty text
 * 2. Missing OPENAI_API_KEY → clear NOT_CONFIGURED (not 500)
 */
import { spawnSync } from 'node:child_process';
import { readFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import { ulid } from 'ulid';
import { prisma } from '../../../src/lib/db.js';
import { signAccess } from '../../../src/lib/auth.js';
import { voiceRoutes } from '../../../src/routes/voice.js';

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT FAIL: ${msg}`);
}

/** Produce a short audio file OpenAI Whisper accepts (wav preferred). */
async function makeShortAudio(): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const tmp = path.join(os.tmpdir(), `t08-voice-${ulid().slice(-8)}`);
  const aiff = `${tmp}.aiff`;
  const wav = `${tmp}.wav`;
  const m4a = `${tmp}.m4a`;

  // macOS `say` → aiff, then afconvert → wav (OpenAI supports wav).
  const say = spawnSync('say', ['hello test', '-o', aiff], { encoding: 'utf8' });
  if (say.status !== 0) {
    throw new Error(
      `say failed (status ${say.status}): ${say.stderr || say.stdout || 'no output'}. ` +
        'Need macOS `say` to generate test audio.',
    );
  }

  // Prefer afconvert (built-in on macOS).
  const afc = spawnSync('afconvert', ['-f', 'WAVE', '-d', 'LEI16', aiff, wav], {
    encoding: 'utf8',
  });
  if (afc.status === 0 && existsSync(wav)) {
    await unlink(aiff).catch(() => {});
    return {
      path: wav,
      cleanup: async () => {
        await unlink(wav).catch(() => {});
      },
    };
  }

  // Fallback: try m4a via say (some macOS versions accept -o .m4a).
  const sayM4a = spawnSync('say', ['hello test', '-o', m4a], { encoding: 'utf8' });
  if (sayM4a.status === 0 && existsSync(m4a)) {
    await unlink(aiff).catch(() => {});
    return {
      path: m4a,
      cleanup: async () => {
        await unlink(m4a).catch(() => {});
      },
    };
  }

  // Last resort: if aiff exists, still try uploading it (may fail OpenAI format check).
  if (existsSync(aiff)) {
    console.warn(
      'WARN: afconvert/m4a unavailable; uploading aiff (OpenAI may reject). ' +
        `afconvert stderr: ${afc.stderr || '(none)'}`,
    );
    return {
      path: aiff,
      cleanup: async () => {
        await unlink(aiff).catch(() => {});
      },
    };
  }

  throw new Error('Could not produce test audio (say/afconvert failed)');
}

async function main() {
  console.log('── t08: Voice transcription (Whisper) ──');

  const owner = await prisma.user.findFirst({
    where: { deletedAt: null, role: { in: ['OWNER', 'TRAINER'] } },
  });
  assert(owner, 'need OWNER/TRAINER user in DB');
  const token = await signAccess({ sub: owner.id, role: owner.role, email: owner.email });

  // Snapshot env so we can restore after missing-key test.
  const origKey = process.env.OPENAI_API_KEY;
  const origEnabled = process.env.VOICE_ENABLED;

  // ── [1] Real transcription with short audio ──────────────────────────────
  console.log('\n── [1] Live transcribe short audio ──');
  assert(!!origKey?.trim(), 'OPENAI_API_KEY must be set in env for live test');

  // Ensure config is loaded with key present (config reads env at import time).
  // voiceRoutes imports config at module load; we need the key already set.
  // Re-import won't re-read; config was loaded when voiceRoutes was imported.
  // So for live test we rely on process env having been set before this process started.
  const { config } = await import('../../../src/config.js');
  assert(config.openaiApiKey, 'config.openaiApiKey empty — set OPENAI_API_KEY before running');
  assert(config.voice.enabled, 'voice.enabled must be true for live test');
  console.log('voice.model:', config.voice.model);
  console.log('openaiApiKey present:', !!config.openaiApiKey);

  const audio = await makeShortAudio();
  console.log('audio file:', audio.path);

  const app = Fastify({ logger: false });
  await app.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
  await app.register(voiceRoutes);
  await app.ready();

  try {
    const buf = await readFile(audio.path);
    const filename = path.basename(audio.path);
    const boundary = `----t08boundary${ulid()}`;
    const mime =
      filename.endsWith('.wav') ? 'audio/wav' :
      filename.endsWith('.m4a') ? 'audio/mp4' :
      filename.endsWith('.aiff') ? 'audio/aiff' :
      'application/octet-stream';

    const preamble = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="${filename}"\r\n` +
        `Content-Type: ${mime}\r\n\r\n`,
    );
    const closing = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([preamble, buf, closing]);

    const res = await app.inject({
      method: 'POST',
      url: '/api/voice/transcribe',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });

    console.log('status:', res.statusCode);
    console.log('body:', res.body.slice(0, 500));
    assert(res.statusCode === 200, `expected 200, got ${res.statusCode}: ${res.body}`);
    const json = JSON.parse(res.body) as {
      success: boolean;
      data?: { text?: string };
      error?: { code: string; message: string };
    };
    assert(json.success === true, `expected success: ${res.body}`);
    assert(typeof json.data?.text === 'string', 'data.text must be string');
    assert(json.data!.text!.trim().length > 0, `expected non-empty text, got: ${JSON.stringify(json.data?.text)}`);
    console.log('transcript:', JSON.stringify(json.data!.text));
    console.log('[1] OK');
  } finally {
    await audio.cleanup();
    await app.close();
  }

  // ── [2] Missing key → clear NOT_CONFIGURED (not 500) ─────────────────────
  // config is a frozen object loaded at import — we cannot unset env and re-read.
  // Instead unit-test the route's error path by temporarily patching config.
  console.log('\n── [2] Missing key returns clear error ──');
  const { config: cfg } = await import('../../../src/config.js');
  const desc = Object.getOwnPropertyDescriptor(cfg, 'openaiApiKey');
  // config is `as const` plain object — properties are writable unless frozen.
  const prev = (cfg as { openaiApiKey: string }).openaiApiKey;
  try {
    (cfg as { openaiApiKey: string }).openaiApiKey = '';

    const app2 = Fastify({ logger: false });
    await app2.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
    await app2.register(voiceRoutes);
    await app2.ready();

    try {
      // Minimal fake multipart (route should fail before OpenAI call).
      const boundary = '----t08nokey';
      const payload =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="x.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n` +
        `fake\r\n` +
        `--${boundary}--\r\n`;

      const res2 = await app2.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });

      console.log('status:', res2.statusCode);
      console.log('body:', res2.body.slice(0, 400));
      assert(res2.statusCode !== 500, 'must not 500 when key missing');
      assert(
        res2.statusCode === 412 || res2.statusCode === 400,
        `expected 412/400, got ${res2.statusCode}`,
      );
      const j2 = JSON.parse(res2.body) as {
        success: boolean;
        error?: { code: string; message: string };
      };
      assert(j2.success === false, 'success should be false');
      assert(
        j2.error?.code === 'NOT_CONFIGURED' || /OPENAI_API_KEY|未設定|not configured/i.test(j2.error?.message ?? ''),
        `clear error about missing key, got: ${JSON.stringify(j2.error)}`,
      );
      console.log('[2] OK — code:', j2.error?.code, 'message:', j2.error?.message);
    } finally {
      await app2.close();
    }
  } finally {
    (cfg as { openaiApiKey: string }).openaiApiKey = prev;
    void desc;
    void origEnabled;
    // restore env for cleanliness
    if (origKey !== undefined) process.env.OPENAI_API_KEY = origKey;
  }

  // ── [3] voice.enabled=false → clear error ────────────────────────────────
  console.log('\n── [3] voice.enabled=false returns clear error ──');
  const prevEnabled = (cfg as { voice: { enabled: boolean } }).voice.enabled;
  try {
    // voice is nested const object — mutate enabled
    (cfg.voice as { enabled: boolean }).enabled = false;

    const app3 = Fastify({ logger: false });
    await app3.register(multipart, { limits: { fileSize: 25 * 1024 * 1024 } });
    await app3.register(voiceRoutes);
    await app3.ready();
    try {
      const boundary = '----t08disabled';
      const payload =
        `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="file"; filename="x.wav"\r\n` +
        `Content-Type: audio/wav\r\n\r\n` +
        `fake\r\n` +
        `--${boundary}--\r\n`;
      const res3 = await app3.inject({
        method: 'POST',
        url: '/api/voice/transcribe',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': `multipart/form-data; boundary=${boundary}`,
        },
        payload,
      });
      console.log('status:', res3.statusCode);
      console.log('body:', res3.body.slice(0, 400));
      assert(res3.statusCode !== 500, 'must not 500 when disabled');
      const j3 = JSON.parse(res3.body) as {
        success: boolean;
        error?: { code: string; message: string };
      };
      assert(j3.success === false, 'success should be false');
      assert(
        j3.error?.code === 'NOT_CONFIGURED' || /關閉|disabled|VOICE_ENABLED/i.test(j3.error?.message ?? ''),
        `clear disabled error, got: ${JSON.stringify(j3.error)}`,
      );
      console.log('[3] OK — code:', j3.error?.code, 'message:', j3.error?.message);
    } finally {
      await app3.close();
    }
  } finally {
    (cfg.voice as { enabled: boolean }).enabled = prevEnabled;
  }

  console.log('\n── t08 ALL PASSED ──');
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error('t08 FAILED:', e);
  await prisma.$disconnect().catch(() => {});
  process.exit(1);
});
