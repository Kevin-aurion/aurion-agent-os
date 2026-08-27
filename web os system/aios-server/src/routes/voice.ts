// Voice transcription via OpenAI Whisper.
// Multipart audio → OpenAI audio/transcriptions → redactSecrets → { text }.
// Draft-capture helper for Teach mode: any authenticated user (MEMBER may dictate
// training text). Does not confirm skills or mutate agent config.
// No new dependencies; uses Node built-in fetch / FormData / Blob.
import type { FastifyInstance } from 'fastify';
import { config } from '../config.js';
import { requireAuth } from '../lib/guard.js';
import { ok, errors, sendError } from '../lib/http.js';
import { redactSecrets } from '../memory/redactor.js';

const OPENAI_TRANSCRIPTIONS_URL = 'https://api.openai.com/v1/audio/transcriptions';

export async function voiceRoutes(app: FastifyInstance) {
  app.post('/api/voice/transcribe', { preHandler: requireAuth }, async (req, reply) => {
    try {
      if (!config.voice.enabled) {
        throw errors.notConfigured(
          '語音轉錄已關閉（VOICE_ENABLED=false）。請改用打字輸入。',
        );
      }
      if (!config.openaiApiKey) {
        throw errors.notConfigured(
          '未設定 OPENAI_API_KEY，無法使用語音轉錄。請改用打字輸入。',
        );
      }

      const file = await req.file();
      if (!file) {
        throw errors.badRequest('No audio file uploaded (expected multipart field "file")');
      }

      const buf = await file.toBuffer();
      if (!buf.length) {
        throw errors.badRequest('Uploaded audio file is empty');
      }

      const filename = file.filename || 'audio.webm';
      const mime = file.mimetype || 'application/octet-stream';

      const form = new FormData();
      form.append('file', new Blob([buf], { type: mime }), filename);
      form.append('model', config.voice.model);

      const res = await fetch(OPENAI_TRANSCRIPTIONS_URL, {
        method: 'POST',
        headers: { Authorization: `Bearer ${config.openaiApiKey}` },
        body: form,
      });

      if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        const snippet = errBody.slice(0, 300);
        if (res.status === 401 || res.status === 403) {
          throw errors.notConfigured(
            `OpenAI API 金鑰無效或無權限（HTTP ${res.status}）。請檢查 OPENAI_API_KEY。`,
          );
        }
        throw errors.badRequest(
          `OpenAI 轉錄失敗（HTTP ${res.status}）${snippet ? `: ${snippet}` : ''}`,
        );
      }

      const data = (await res.json()) as { text?: unknown };
      const rawText = typeof data.text === 'string' ? data.text : '';
      const text = redactSecrets(rawText);

      return ok({ text });
    } catch (e) {
      return sendError(reply, e);
    }
  });
}
