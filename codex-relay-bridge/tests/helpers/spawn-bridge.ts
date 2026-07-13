/**
 * Helpers for integration tests: path to fake app-server + RelayCore factory.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RelayCore, type RelayCoreOptions } from "../../src/relay-core/index.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FAKE_APP_SERVER = path.resolve(here, "fake-app-server.ts");
export const AURION_PROJECT = "/Users/kevin/Documents/aurion";

export function fakeCodexBin(): string {
  // Use node + tsx to run the fake as if it were the codex binary.
  // AppServerClient does: spawn(CODEX_BIN, ["app-server"], ...)
  // So CODEX_BIN must be an executable that ignores "app-server" or we wrap it.
  return path.resolve(here, "fake-codex-bin.sh");
}

export function createTestRelay(
  opts: Partial<RelayCoreOptions> & {
    fakeLog?: string;
    fakeScript?: unknown[];
    fakeResponseLog?: string;
    env?: Record<string, string>;
  } = {},
): RelayCore {
  const childEnv: Record<string, string | undefined> = {
    FAKE_LOG: opts.fakeLog,
    FAKE_SCRIPT: opts.fakeScript
      ? JSON.stringify(opts.fakeScript)
      : undefined,
    FAKE_RESPONSE_LOG: opts.fakeResponseLog,
    ...(opts.env ?? {}),
  };

  return new RelayCore({
    codexBin: opts.codexBin ?? fakeCodexBin(),
    approvalTimeoutMs: opts.approvalTimeoutMs ?? 120_000,
    handshakeTimeoutMs: opts.handshakeTimeoutMs ?? 5_000,
    requestTimeoutMs: opts.requestTimeoutMs ?? 10_000,
    packageVersion: "0.1.0-test",
    autoStart: opts.autoStart !== false,
    childEnv,
  });
}

export function readJsonLines(filePath: string): unknown[] {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as unknown);
  } catch {
    return [];
  }
}

export async function readJsonLinesAsync(
  filePath: string,
): Promise<Record<string, unknown>[]> {
  const fs = await import("node:fs/promises");
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return [];
  }
}

export function methodsOf(
  lines: Array<Record<string, unknown>>,
): string[] {
  return lines
    .filter((l) => typeof l.method === "string")
    .map((l) => l.method as string);
}

export async function waitFor(
  pred: () => boolean | Promise<boolean>,
  timeoutMs = 3000,
  intervalMs = 25,
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error("waitFor timeout");
}
