/**
 * Fail-closed device eligibility for targeted Computer Use / device-local MCP.
 * DB/parse errors ⇒ not eligible. Never silently substitutes another device.
 */
import { prisma } from './db.js';
import { isDeviceOnline } from '../ws/hub.js';
import {
  LINE_DESKTOP_MANIFEST,
  LINE_DESKTOP_MCP_KEY,
  isLineTool,
} from './devicemcp.js';
import type { Device, DeviceCapabilities } from './device.js';
import { DeviceCapabilitiesSchema } from './device.js';

export type EligibilityRequirement =
  | 'computer_use'
  | 'line_desktop'
  | 'screenshot'
  | { kind: 'line_tool'; tool: string }
  | { kind: 'mcp_tool'; mcpKey: string; tool: string };

export type EligibilityReasonCode =
  | 'OK'
  | 'DEVICE_NOT_FOUND'
  | 'DEVICE_NOT_ACTIVE'
  | 'DEVICE_OFFLINE'
  | 'NOT_BOUND'
  | 'CAPABILITIES_MISSING'
  | 'CAPABILITIES_INVALID'
  | 'FEATURE_MISSING'
  | 'MCP_NOT_READY'
  | 'MCP_VERSION_MISMATCH'
  | 'MCP_SHA_MISMATCH'
  | 'MCP_TOOL_MISSING'
  | 'INTERNAL_ERROR';

export interface EligibilityResult {
  eligible: boolean;
  reasonCode: EligibilityReasonCode;
  reason: string;
  device?: SafeEligibleDevice;
}

export interface SafeEligibleDevice {
  id: string;
  name: string;
  platform: string;
  status: string;
  lastSeenAt: Date | null;
  osVersion: string | null;
  appVersion: string | null;
  features?: {
    computerUse: boolean;
    screenRecording: boolean;
    accessibility: boolean;
    screenshot: boolean;
    codexApp: boolean;
    codexCli: boolean;
    lineDesktop: boolean;
  };
  online: true;
}

/** Normalize stored JSON so omitted codexApp/codexCli/lineDesktop default to false. */
function parseCaps(raw: unknown): DeviceCapabilities | null {
  try {
    if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
      const o = raw as Record<string, unknown>;
      const feat = (o.features && typeof o.features === 'object' && !Array.isArray(o.features)
        ? { ...(o.features as Record<string, unknown>) }
        : {}) as Record<string, unknown>;
      // Wire compatibility: omitted new flags default false before strict schema parse.
      if (feat.codexApp === undefined) feat.codexApp = false;
      if (feat.codexCli === undefined) feat.codexCli = false;
      if (feat.lineDesktop === undefined) feat.lineDesktop = false;
      return DeviceCapabilitiesSchema.parse({ ...o, features: feat });
    }
    return DeviceCapabilitiesSchema.parse(raw);
  } catch {
    return null;
  }
}

function requirementLabel(req: EligibilityRequirement): string {
  if (typeof req === 'string') return req;
  if (req.kind === 'line_tool') return `line_tool:${req.tool}`;
  return `mcp_tool:${req.mcpKey}:${req.tool}`;
}

/**
 * Single fail-closed eligibility check for one device + agent + requirement.
 */
export async function checkDeviceEligibility(opts: {
  deviceId: string;
  agentId: string;
  requirement: EligibilityRequirement;
  /**
   * When requirement is computer_use and true (default), also require
   * features.screenshot or features.screenRecording (default COMPUTER_CONTROL checkpoint).
   */
  requireScreenCapture?: boolean;
}): Promise<EligibilityResult> {
  try {
    const device = await prisma.device.findUnique({ where: { id: opts.deviceId } });
    if (!device) {
      return { eligible: false, reasonCode: 'DEVICE_NOT_FOUND', reason: 'Device not found' };
    }
    if (device.status !== 'ACTIVE') {
      return {
        eligible: false,
        reasonCode: 'DEVICE_NOT_ACTIVE',
        reason: `Device status is ${device.status}`,
      };
    }
    if (!isDeviceOnline(opts.deviceId)) {
      return {
        eligible: false,
        reasonCode: 'DEVICE_OFFLINE',
        reason: 'Device WebSocket offline or heartbeat stale',
      };
    }

    const binding = await prisma.agentDevice.findUnique({
      where: {
        agentId_deviceId: { agentId: opts.agentId, deviceId: opts.deviceId },
      },
    });
    if (!binding) {
      return {
        eligible: false,
        reasonCode: 'NOT_BOUND',
        reason: 'Agent is not bound to this device',
      };
    }

    if (!device.capabilities) {
      return {
        eligible: false,
        reasonCode: 'CAPABILITIES_MISSING',
        reason: 'Device has not reported capabilities',
      };
    }
    const caps = parseCaps(device.capabilities);
    if (!caps) {
      return {
        eligible: false,
        reasonCode: 'CAPABILITIES_INVALID',
        reason: 'Device capabilities failed schema validation',
      };
    }

    const req = opts.requirement;
    if (req === 'computer_use') {
      if (!caps.features.computerUse) {
        return {
          eligible: false,
          reasonCode: 'FEATURE_MISSING',
          reason: 'features.computerUse is false',
        };
      }
      // Generic computerUse alone cannot masquerade as installed Codex App host.
      if (!caps.features.codexApp) {
        return {
          eligible: false,
          reasonCode: 'FEATURE_MISSING',
          reason: 'features.codexApp is false (Codex App required for Computer Use)',
        };
      }
      // Default COMPUTER_CONTROL checkpoint requires a capture capability.
      const needCapture = opts.requireScreenCapture !== false;
      if (needCapture && !caps.features.screenshot && !caps.features.screenRecording) {
        return {
          eligible: false,
          reasonCode: 'FEATURE_MISSING',
          reason: 'COMPUTER_CONTROL checkpoint requires features.screenshot or features.screenRecording',
        };
      }
    } else if (req === 'screenshot') {
      if (!caps.features.screenshot && !caps.features.screenRecording) {
        return {
          eligible: false,
          reasonCode: 'FEATURE_MISSING',
          reason: 'features.screenshot/screenRecording is false',
        };
      }
    } else if (req === 'line_desktop' || (typeof req === 'object' && req.kind === 'line_tool')) {
      const tool = typeof req === 'object' && req.kind === 'line_tool' ? req.tool : null;
      if (tool && !isLineTool(tool)) {
        return {
          eligible: false,
          reasonCode: 'MCP_TOOL_MISSING',
          reason: `Unknown LINE tool: ${tool}`,
        };
      }
      if (!caps.features.accessibility) {
        return {
          eligible: false,
          reasonCode: 'FEATURE_MISSING',
          reason: 'LINE Desktop requires features.accessibility',
        };
      }
      if (!caps.features.lineDesktop) {
        return {
          eligible: false,
          reasonCode: 'FEATURE_MISSING',
          reason: 'features.lineDesktop is false (LINE Desktop app not reported)',
        };
      }
      const mcpCheck = await checkLineMcpReady(opts.deviceId, tool);
      if (!mcpCheck.eligible) return mcpCheck;
    } else if (typeof req === 'object' && req.kind === 'mcp_tool') {
      if (req.mcpKey !== LINE_DESKTOP_MCP_KEY) {
        return {
          eligible: false,
          reasonCode: 'MCP_NOT_READY',
          reason: `Unsupported mcpKey: ${req.mcpKey}`,
        };
      }
      const mcpCheck = await checkLineMcpReady(opts.deviceId, req.tool);
      if (!mcpCheck.eligible) return mcpCheck;
    }

    return {
      eligible: true,
      reasonCode: 'OK',
      reason: 'eligible',
      device: toSafeEligible(device, caps),
    };
  } catch (e) {
    return {
      eligible: false,
      reasonCode: 'INTERNAL_ERROR',
      reason: e instanceof Error ? e.message : String(e),
    };
  }
}

async function checkLineMcpReady(
  deviceId: string,
  tool: string | null,
): Promise<EligibilityResult> {
  const m = LINE_DESKTOP_MANIFEST;
  const install = await prisma.deviceMcpInstallation.findUnique({
    where: {
      deviceId_mcpKey: { deviceId, mcpKey: LINE_DESKTOP_MCP_KEY },
    },
  });
  if (!install || install.status !== 'READY') {
    return {
      eligible: false,
      reasonCode: 'MCP_NOT_READY',
      reason: `LINE MCP not READY (status=${install?.status ?? 'missing'})`,
    };
  }
  if (install.version !== m.version) {
    return {
      eligible: false,
      reasonCode: 'MCP_VERSION_MISMATCH',
      reason: `expected ${m.version}, got ${install.version}`,
    };
  }
  if (install.sha256.toLowerCase() !== m.sha256.toLowerCase()) {
    return {
      eligible: false,
      reasonCode: 'MCP_SHA_MISMATCH',
      reason: 'LINE MCP sha256 mismatch',
    };
  }
  const allow = new Set(install.toolAllowlist);
  for (const t of m.toolAllowlist) {
    if (!allow.has(t)) {
      return {
        eligible: false,
        reasonCode: 'MCP_TOOL_MISSING',
        reason: `allowlist missing required tool ${t}`,
      };
    }
  }
  if (tool && !allow.has(tool)) {
    return {
      eligible: false,
      reasonCode: 'MCP_TOOL_MISSING',
      reason: `tool ${tool} not in install allowlist`,
    };
  }
  return { eligible: true, reasonCode: 'OK', reason: 'eligible' };
}

function toSafeEligible(device: Device, caps: DeviceCapabilities): SafeEligibleDevice {
  return {
    id: device.id,
    name: device.name,
    platform: device.platform,
    status: device.status,
    lastSeenAt: device.lastSeenAt,
    osVersion: device.osVersion,
    appVersion: device.appVersion,
    features: {
      computerUse: !!caps.features.computerUse,
      screenRecording: !!caps.features.screenRecording,
      accessibility: !!caps.features.accessibility,
      screenshot: !!caps.features.screenshot,
      codexApp: !!caps.features.codexApp,
      codexCli: !!caps.features.codexCli,
      lineDesktop: !!caps.features.lineDesktop,
    },
    online: true,
  };
}

/** List only eligible online devices for an agent + requirement. Offline never appears. */
export async function listEligibleDevices(
  agentId: string,
  requirement: EligibilityRequirement,
): Promise<{ requirement: string; devices: SafeEligibleDevice[] }> {
  const bindings = await prisma.agentDevice.findMany({
    where: { agentId },
    select: { deviceId: true },
  });
  const devices: SafeEligibleDevice[] = [];
  for (const b of bindings) {
    const r = await checkDeviceEligibility({
      deviceId: b.deviceId,
      agentId,
      requirement,
    });
    if (r.eligible && r.device) devices.push(r.device);
  }
  return { requirement: requirementLabel(requirement), devices };
}

const KNOWN_REQUIREMENTS = new Set(['computer_use', 'line_desktop', 'screenshot']);

/**
 * Parse requirement query. Unknown values throw (route maps to HTTP 400).
 * Empty/undefined defaults to computer_use.
 */
export function parseRequirementQuery(raw: string | undefined): EligibilityRequirement {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return 'computer_use';
  }
  const v = String(raw).trim().toLowerCase();
  if (v === 'computer_use' || v === 'line_desktop' || v === 'screenshot') {
    return v;
  }
  throw new Error(
    `Unknown requirement "${raw}". Allowed: ${[...KNOWN_REQUIREMENTS].join(', ')}`,
  );
}

/** True when parseRequirementQuery would throw (for routes without try/catch semantics). */
export function isKnownRequirementQuery(raw: string | undefined): boolean {
  if (raw === undefined || raw === null || String(raw).trim() === '') return true;
  return KNOWN_REQUIREMENTS.has(String(raw).trim().toLowerCase());
}
