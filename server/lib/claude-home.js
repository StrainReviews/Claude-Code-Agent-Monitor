const path = require("path");
const os = require("os");
const fs = require("fs");

/**
 * Centralized Claude Code home directory path management.
 * Supports custom paths via the CLAUDE_HOME environment variable (e.g. ~/.codefuse/engine/cc/).
 */

function getClaudeHome() {
  return process.env.CLAUDE_HOME || path.join(os.homedir(), ".claude");
}

function getProjectsDir() {
  return path.join(getClaudeHome(), "projects");
}

function getSettingsPath() {
  return path.join(getClaudeHome(), "settings.json");
}

/**
 * Claude Code path encoding: replace all non-alphanumeric characters with "-".
 * Example: "/Users/txj/.codefuse" → "-Users-txj--codefuse"
 * Note: not just "/", characters like "." are also replaced.
 */
function encodeCwd(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

/**
 * Infer the main session JSONL file path from sessionId and cwd.
 * Encoding rule: all non-alphanumeric characters replaced with "-".
 * Falls back to scanning all project directories if the encoded path doesn't exist.
 */
function getTranscriptPath(sessionId, cwd) {
  if (!cwd) return null;
  const encoded = encodeCwd(cwd);
  const candidate = path.join(getProjectsDir(), encoded, `${sessionId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: scan projects/ subdirectories
  return findTranscriptPath(sessionId);
}

/**
 * Infer the sub-agent JSONL file path from sessionId, cwd, and agentId.
 * Falls back to scanning all project directories if the encoded path doesn't exist.
 */
function getSubagentTranscriptPath(sessionId, cwd, agentId) {
  if (!cwd) return null;
  const encoded = encodeCwd(cwd);
  const candidate = path.join(getProjectsDir(), encoded, sessionId, "subagents", `agent-${agentId}.jsonl`);
  if (fs.existsSync(candidate)) return candidate;
  // Fallback: scan all project directories
  return findSubagentTranscriptPath(sessionId, agentId);
}

/**
 * When cwd is unknown, scan projects/ subdirectories to find the JSONL file for a sessionId.
 * Returns the found path or null.
 */
function findTranscriptPath(sessionId) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const candidate = path.join(projectsDir, d.name, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
  } catch {
    // Permission or IO error, ignore
  }
  return null;
}

/**
 * Find a sub-agent JSONL file path by scanning when cwd is unknown.
 * Supports exact match and prefix fuzzy match:
 * - Exact: agent-<agentId>.jsonl
 * - Fuzzy: agent-acompact-*.jsonl (for compaction type)
 */
function findSubagentTranscriptPath(sessionId, agentId) {
  const projectsDir = getProjectsDir();
  if (!fs.existsSync(projectsDir)) return null;
  try {
    const dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const subagentsDir = path.join(projectsDir, d.name, sessionId, "subagents");
      if (!fs.existsSync(subagentsDir)) continue;

      // Exact match
      const exact = path.join(subagentsDir, `agent-${agentId}.jsonl`);
      if (fs.existsSync(exact)) return exact;

      // Prefix fuzzy match (compaction type: agentId starts with "acompact-")
      if (agentId.startsWith("acompact-")) {
        const files = fs.readdirSync(subagentsDir);
        const match = files.find((f) => f.startsWith("agent-acompact-") && f.endsWith(".jsonl"));
        if (match) return path.join(subagentsDir, match);
      }
    }
  } catch {
    // Ignore
  }
  return null;
}

module.exports = {
  getClaudeHome,
  getProjectsDir,
  getSettingsPath,
  getTranscriptPath,
  getSubagentTranscriptPath,
  findTranscriptPath,
  findSubagentTranscriptPath,
};