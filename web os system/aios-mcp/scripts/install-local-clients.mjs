import { chmod, cp, mkdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const entrypoint = path.join(packageRoot, 'dist', 'index.js');
const envPath = path.join(packageRoot, '.env');
const skillSource = path.join(packageRoot, 'skills', 'build-aios-agent');
const skillDestination = path.join(os.homedir(), '.claude', 'skills', 'build-aios-agent');
const claudeConfig = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'Claude',
  'claude_desktop_config.json',
);
const cursorConfig = path.join(os.homedir(), '.cursor', 'mcp.json');
const claudeCodeConfig = path.join(os.homedir(), '.claude.json');
const claudeCodeSettings = path.join(os.homedir(), '.claude', 'settings.json');
const claudeCodeAiosToolRules = [
  'mcp__aios__prepare_agent_build_prompt',
  'mcp__aios__start_agent_build',
  'mcp__aios__sync_agent_build_turn',
  'mcp__aios__sync_agent_build_artifact',
  'mcp__aios__upsert_agent_build_snapshot',
  'mcp__aios__upload_agent_build_file',
  'mcp__aios__guard_agent_build_stop',
  'mcp__aios__get_agent_build',
  'mcp__aios__list_agent_builds',
  'mcp__aios__list_testable_agents',
  'mcp__aios__chat_with_test_agent',
  'mcp__aios__submit_agent_build_for_fde_review',
  'mcp__aios__submit_agent_build_test_data',
  'mcp__aios__run_agent_build_test',
];

async function requireFile(file, label) {
  try {
    const info = await stat(file);
    if (!info.isFile()) throw new Error();
  } catch {
    throw new Error(`${label} is missing: ${file}`);
  }
}

async function readJsonObject(file) {
  try {
    const value = JSON.parse(await readFile(file, 'utf8'));
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new Error(`Cannot safely update invalid JSON file ${file}: ${error.message}`);
  }
}

async function writeJsonWithBackup(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  try {
    await stat(file);
    await cp(file, `${file}.aios-backup`, { force: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  await chmod(temporary, 0o600);
  await rename(temporary, file);
  await chmod(file, 0o600);
}

async function installMcpConfig(file) {
  const config = await readJsonObject(file);
  const mcpServers = config.mcpServers && typeof config.mcpServers === 'object'
    ? config.mcpServers
    : {};
  config.mcpServers = {
    ...mcpServers,
    aios: {
      command: process.execPath,
      args: [entrypoint],
    },
  };
  await writeJsonWithBackup(file, config);
}

async function installClaudeBuilderPermissions(file) {
  const config = await readJsonObject(file);
  const permissions = config.permissions && typeof config.permissions === 'object'
    ? config.permissions
    : {};
  const existingAllow = Array.isArray(permissions.allow) ? permissions.allow : [];
  config.permissions = {
    ...permissions,
    allow: [...new Set([...existingAllow, ...claudeCodeAiosToolRules])],
  };
  // stage-0: do not write UserPromptSubmit/Stop mcp_tool hooks; they misfire on ordinary turns.
  await writeJsonWithBackup(file, config);
}

await requireFile(entrypoint, 'Built MCP entrypoint');
await requireFile(envPath, 'Private MCP environment');
await requireFile(path.join(skillSource, 'SKILL.md'), 'AIOS Agent Builder Skill');

await installMcpConfig(claudeConfig);
await installMcpConfig(cursorConfig);
await installMcpConfig(claudeCodeConfig);
await installClaudeBuilderPermissions(claudeCodeSettings);

await mkdir(path.dirname(skillDestination), { recursive: true });
await rm(skillDestination, { recursive: true, force: true });
await cp(skillSource, skillDestination, { recursive: true });

console.log(`Installed AIOS MCP in Claude Desktop: ${claudeConfig}`);
console.log(`Installed AIOS MCP in Cursor: ${cursorConfig}`);
console.log(`Installed AIOS MCP in Claude Code: ${claudeCodeConfig}`);
console.log(`Installed AIOS-only tool permissions in Claude Code: ${claudeCodeSettings}`);
console.log(`Installed the local Claude/Claude Code skill: ${skillDestination}`);
console.log('Restart Claude Desktop and Cursor so they reload MCP configuration.');
