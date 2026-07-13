// Pluggable embedding providers for memory indexing / recall.
// Primary: OpenRouter Gemini embedding (google/gemini-embedding-001, default dim 3072).
// Fallback: Google Gemini embeddings API (GEMINI_API_KEY) — same EmbeddingProvider interface.
// Call sites must try/catch: embedding failures must never fail run/chat.
import { config } from '../config.js';

export interface EmbeddingProvider {
  readonly id: string;
  readonly dimension: number;
  embed(texts: string[]): Promise<number[][]>;
}

/** OpenRouter /v1/embeddings — model id e.g. google/gemini-embedding-001. */
export class OpenRouterEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'openrouter';
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { baseUrl?: string; apiKey?: string; model?: string; dimension?: number }) {
    this.baseUrl = (opts?.baseUrl ?? config.memory.openrouterBaseUrl).replace(/\/$/, '');
    this.apiKey = opts?.apiKey ?? config.memory.openrouterApiKey;
    this.model = opts?.model ?? config.memory.embeddingModel;
    this.dimension = opts?.dimension ?? config.memory.embeddingDimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OPENROUTER_API_KEY is empty — cannot embed (set key or disable MEMORY_ENABLED)');
    }
    if (texts.length === 0) return [];

    const body: Record<string, unknown> = {
      model: this.model,
      input: texts.length === 1 ? texts[0] : texts,
    };
    // Some OpenRouter / Gemini models accept dimensions; safe to include when set.
    if (this.dimension > 0) {
      body.dimensions = this.dimension;
    }

    const res = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`OpenRouter embeddings HTTP ${res.status}: ${errText.slice(0, 400)}`);
    }

    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[]; index?: number }>;
      error?: { message?: string };
    };
    if (!data.data?.length) {
      throw new Error(`OpenRouter embeddings empty response: ${data.error?.message ?? 'no data'}`);
    }

    // Sort by index so batch order matches input.
    const sorted = [...data.data].sort((a, b) => (a.index ?? 0) - (b.index ?? 0));
    return sorted.map((row, i) => {
      const vec = row.embedding;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error(`OpenRouter embeddings missing vector at index ${i}`);
      }
      return vec;
    });
  }
}

/**
 * Direct Google Gemini embeddings API (fallback when OpenRouter /embeddings is
 * unavailable for the chosen model). Same EmbeddingProvider interface — switch
 * via EMBEDDING_PROVIDER=google + GEMINI_API_KEY; call sites need no change.
 *
 * Endpoint: POST https://generativelanguage.googleapis.com/v1beta/models/{model}:embedContent
 * Model example: gemini-embedding-001 (without google/ prefix).
 */
export class GoogleGeminiEmbeddingProvider implements EmbeddingProvider {
  readonly id = 'google';
  readonly dimension: number;
  private readonly apiKey: string;
  private readonly model: string;

  constructor(opts?: { apiKey?: string; model?: string; dimension?: number }) {
    this.apiKey = opts?.apiKey ?? config.memory.geminiApiKey;
    // Accept either "google/gemini-embedding-001" or "gemini-embedding-001".
    const raw = opts?.model ?? config.memory.embeddingModel;
    this.model = raw.replace(/^google\//, '');
    this.dimension = opts?.dimension ?? config.memory.embeddingDimension;
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('GEMINI_API_KEY is empty — cannot embed via Google direct fallback');
    }
    if (texts.length === 0) return [];

    // Google embedContent is single-input; batch with Promise.all (bounded by caller chunk size).
    const out: number[][] = [];
    for (const text of texts) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${this.model}:embedContent?key=${encodeURIComponent(this.apiKey)}`;
      const body: Record<string, unknown> = {
        content: { parts: [{ text }] },
      };
      if (this.dimension > 0) {
        body.outputDimensionality = this.dimension;
      }
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const errText = await res.text().catch(() => '');
        throw new Error(`Google Gemini embeddings HTTP ${res.status}: ${errText.slice(0, 400)}`);
      }
      const data = (await res.json()) as { embedding?: { values?: number[] } };
      const vec = data.embedding?.values;
      if (!Array.isArray(vec) || vec.length === 0) {
        throw new Error('Google Gemini embeddings missing vector');
      }
      out.push(vec);
    }
    return out;
  }
}

let cached: EmbeddingProvider | null = null;

/** Factory: selects provider from config.memory.embeddingProvider. */
export function getEmbeddingProvider(): EmbeddingProvider {
  if (cached) return cached;
  const which = (config.memory.embeddingProvider || 'openrouter').toLowerCase();
  if (which === 'google' || which === 'gemini') {
    cached = new GoogleGeminiEmbeddingProvider();
  } else {
    cached = new OpenRouterEmbeddingProvider();
  }
  return cached;
}

/** Test helper — clear cached provider (e.g. after config change in tests). */
export function resetEmbeddingProviderCache(): void {
  cached = null;
}
