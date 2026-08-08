#!/usr/bin/env node
/**
 * Minimal stdio MCP fixture for Ticket 03 broker tests.
 * Newline-delimited JSON-RPC 2.0. Dependency-free.
 *
 * Tools: echo (returns args), sleep (never replies), crash (process.exit(1)).
 */
import readline from 'node:readline';

const rl = readline.createInterface({ input: process.stdin });

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

rl.on('line', (line) => {
  const t = line.trim();
  if (!t) return;
  let msg;
  try {
    msg = JSON.parse(t);
  } catch {
    return;
  }
  // Notifications (no id) — ignore
  if (msg.id == null || msg.id === undefined) return;

  const { id, method, params } = msg;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion ?? '2024-11-05',
      serverInfo: { name: 'echo', version: '9.9.9' },
      capabilities: {},
    });
    return;
  }

  if (method === 'tools/list') {
    reply(id, {
      tools: [
        { name: 'echo', description: 'Echo arguments' },
        { name: 'sleep', description: 'Never replies (timeout test)' },
        { name: 'crash', description: 'Exit process (reconnect test)' },
      ],
    });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments ?? {};
    if (name === 'echo') {
      reply(id, {
        content: [{ type: 'text', text: JSON.stringify(args) }],
      });
      return;
    }
    if (name === 'sleep') {
      // Never reply — client should time out.
      return;
    }
    if (name === 'crash') {
      process.exit(1);
      return;
    }
    replyError(id, -32601, `Unknown tool: ${name}`);
    return;
  }

  // Unknown method
  replyError(id, -32601, `Method not found: ${method}`);
});
