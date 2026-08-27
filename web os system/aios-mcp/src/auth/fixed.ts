import type { AccessTokenProvider } from '../http/client.js';

/** Per-request bearer forwarded by the public Remote MCP OAuth transport. */
export class FixedAccessTokenProvider implements AccessTokenProvider {
  constructor(private readonly token: string) {}

  async getAccess(): Promise<string> {
    return this.token;
  }

  async forceReauth(): Promise<void> {
    // The MCP client owns OAuth refresh. A 401 is returned to the caller so it
    // can refresh through the advertised protected-resource metadata.
  }
}
