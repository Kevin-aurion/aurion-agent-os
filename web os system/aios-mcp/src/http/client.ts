// Thin typed fetch wrapper against AIOS_MCP_BASE_URL.
// - attaches Authorization: Bearer <access> (unless skipAuth)
// - unwraps the aios-server {success:true,data} / {success:false,error:{code,message,detail}} envelope
// - maps error envelopes to a thrown AiosApiError
// - on 401, forces one refresh-or-login cycle and retries the call exactly once
export interface AccessTokenProvider {
  getAccess(): Promise<string>;
  forceReauth(): Promise<void>;
}

type Envelope<T> =
  | { success: true; data: T }
  | { success: false; error: { code: string; message: string; detail?: unknown } };

export class AiosApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'AiosApiError';
  }
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

interface RequestOptions {
  query?: QueryParams;
  body?: unknown;
  /** For /api/health and /api/preflight, which require no auth. */
  skipAuth?: boolean;
}

export class HttpClient {
  constructor(
    private readonly baseUrl: string,
    private readonly auth: AccessTokenProvider,
  ) {}

  get<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('GET', path, options);
  }

  post<T>(path: string, options: RequestOptions = {}): Promise<T> {
    return this.request<T>('POST', path, options);
  }

  /** Multipart upload used by Agent Builder source files. Never accepts a host path. */
  postForm<T>(path: string, form: FormData): Promise<T> {
    return this.requestForm<T>(path, form);
  }

  private async request<T>(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions,
    retried = false,
  ): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    if (options.query) {
      for (const [key, value] of Object.entries(options.query)) {
        if (value !== undefined) url.searchParams.set(key, String(value));
      }
    }

    const headers: Record<string, string> = {};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (!options.skipAuth) headers.authorization = `Bearer ${await this.auth.getAccess()}`;

    let res: Response;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      });
    } catch (err) {
      throw new AiosApiError(
        0,
        'NETWORK',
        `cannot reach aios-server at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (res.status === 401 && !options.skipAuth && !retried) {
      // Access JWT may have just expired — rotate once and retry exactly once.
      await this.auth.forceReauth();
      return this.request<T>(method, path, options, true);
    }

    let json: Envelope<T>;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      throw new AiosApiError(res.status, 'BAD_RESPONSE', `${path} returned non-JSON response (HTTP ${res.status})`);
    }

    if (!json.success) {
      const { code, message, detail } = json.error;
      throw new AiosApiError(res.status, code, message, detail);
    }
    return json.data;
  }

  private async requestForm<T>(path: string, form: FormData, retried = false): Promise<T> {
    const url = new URL(`${this.baseUrl}${path}`);
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { authorization: `Bearer ${await this.auth.getAccess()}` },
        body: form,
      });
    } catch (err) {
      throw new AiosApiError(
        0,
        'NETWORK',
        `cannot reach aios-server at ${this.baseUrl} (${err instanceof Error ? err.message : String(err)})`,
      );
    }

    if (res.status === 401 && !retried) {
      await this.auth.forceReauth();
      return this.requestForm<T>(path, form, true);
    }

    let json: Envelope<T>;
    try {
      json = (await res.json()) as Envelope<T>;
    } catch {
      throw new AiosApiError(res.status, 'BAD_RESPONSE', `${path} returned non-JSON response (HTTP ${res.status})`);
    }
    if (!json.success) {
      const { code, message, detail } = json.error;
      throw new AiosApiError(res.status, code, message, detail);
    }
    return json.data;
  }
}
