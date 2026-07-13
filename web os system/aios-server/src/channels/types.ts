// Shared adapter contract for chat/messaging channels (LINE, and future
// Telegram/Slack/Discord). Route modules dispatch webhook HTTP requests to
// the matching adapter's handleHttp(), if present.
import type { FastifyRequest, FastifyReply } from 'fastify';

export type ChannelName = 'LINE' | 'TELEGRAM' | 'SLACK' | 'DISCORD';

export interface ChannelAdapter {
  channel: ChannelName;
  /** Credentials/config present? (still starts up without them, just no-ops) */
  configured(): boolean;
  /** Handle an inbound webhook HTTP request for this channel, if it accepts webhooks. */
  handleHttp?(req: FastifyRequest, reply: FastifyReply): Promise<void>;
}
