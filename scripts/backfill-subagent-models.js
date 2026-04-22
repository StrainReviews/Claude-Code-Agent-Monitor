#!/usr/bin/env node

/**
 * Backfill script for subagent models and token usage.
 *
 * For every subagent row whose model is NULL, look up its session's Claude Code
 * JSONL directory under ~/.claude/projects/ and scan the matching
 * subagents/agent-<id>.jsonl for the agent's model and token usage. Writes to
 * agents.model and subagent_token_usage.
 *
 * Usage: node scripts/backfill-subagent-models.js [--session <id>] [--dry-run]
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const { db, stmts } = require("../server/db");
const TranscriptCache = require("../server/lib/transcript-cache");

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const arg = (name, def) => {
  const i = args.indexOf(name);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : def;
};

const DRY_RUN = flag("--dry-run");
const ONLY_SESSION = arg("--session", null);
const CLAUDE_PROJECTS = path.join(os.homedir(), ".claude", "projects");

const cache = new TranscriptCache();

function findSubagentFile(sessionId, shortAgentId) {
  // Claude Code stores subagent transcripts at:
  //   ~/.claude/projects/<slug>/<session_id>/subagents/agent-<short>.jsonl
  // The <slug> for a session is unknown from DB alone, so we scan all project
  // slugs for a matching nested directory.
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const slug of fs.readdirSync(CLAUDE_PROJECTS)) {
    const subDir = path.join(CLAUDE_PROJECTS, slug, sessionId, "subagents");
    if (!fs.existsSync(subDir)) continue;
    for (const f of fs.readdirSync(subDir)) {
      if (f.endsWith(".jsonl") && f.includes(shortAgentId)) {
        return path.join(subDir, f);
      }
    }
    // No direct id hit — return dir so caller can scan by description
    return subDir;
  }
  return null;
}

function scanSessionSubagentDir(sessionId) {
  if (!fs.existsSync(CLAUDE_PROJECTS)) return null;
  for (const slug of fs.readdirSync(CLAUDE_PROJECTS)) {
    const subDir = path.join(CLAUDE_PROJECTS, slug, sessionId, "subagents");
    if (fs.existsSync(subDir)) return subDir;
  }
  return null;
}

function readMeta(jsonlPath) {
  const metaPath = jsonlPath.replace(/\.jsonl$/, ".meta.json");
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

const query = ONLY_SESSION
  ? "SELECT * FROM agents WHERE type = 'subagent' AND model IS NULL AND session_id = ?"
  : "SELECT * FROM agents WHERE type = 'subagent' AND model IS NULL";
const rows = ONLY_SESSION ? db.prepare(query).all(ONLY_SESSION) : db.prepare(query).all();

console.log(
  `Found ${rows.length} subagent(s) without model${ONLY_SESSION ? ` in ${ONLY_SESSION}` : ""}.`
);

// Group by session so we only scan each subagents/ directory once.
const bySession = new Map();
for (const row of rows) {
  if (row.subagent_type === "compaction") continue; // synthetic, no transcript
  if (!bySession.has(row.session_id)) bySession.set(row.session_id, []);
  bySession.get(row.session_id).push(row);
}

const update = db.transaction((agent, primaryModel, tokensByModel) => {
  stmts.updateAgentModel.run(primaryModel, agent.id);
  for (const [model, tokens] of Object.entries(tokensByModel)) {
    stmts.replaceSubagentTokens.run(
      agent.id,
      agent.session_id,
      model,
      tokens.input,
      tokens.output,
      tokens.cacheRead,
      tokens.cacheWrite
    );
  }
});

let matched = 0;
let unmatched = 0;

for (const [sessionId, agents] of bySession) {
  const subDir = scanSessionSubagentDir(sessionId);
  if (!subDir) {
    console.log(`[skip] no subagents dir for session ${sessionId.slice(0, 8)}`);
    unmatched += agents.length;
    continue;
  }

  // Build name → file index from meta.json. Sort by mtime so index-based
  // fallback pairing (for agents whose stored name equals the subagent_type
  // instead of the description) is stable.
  const files = fs
    .readdirSync(subDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => {
      const fullPath = path.join(subDir, f);
      return {
        path: fullPath,
        meta: readMeta(fullPath),
        mtime: (() => {
          try {
            return fs.statSync(fullPath).mtimeMs;
          } catch {
            return 0;
          }
        })(),
        claimed: false,
      };
    })
    .sort((a, b) => a.mtime - b.mtime);

  // Sort agents by started_at so they pair up with files in chronological order
  agents.sort((a, b) => (a.started_at || "").localeCompare(b.started_at || ""));

  for (const agent of agents) {
    const truncatedName = agent.name.endsWith("...") ? agent.name.slice(0, -3) : agent.name;

    // 1) Prefix-match on description (current naming convention)
    let match = files.find(
      (f) =>
        !f.claimed && f.meta?.description && agent.name.startsWith(f.meta.description.slice(0, 57))
    );
    // 2) Exact description after trailing "..."
    if (!match) {
      match = files.find((f) => !f.claimed && f.meta?.description === truncatedName);
    }
    // 3) Legacy: agent.name stored as subagent_type (e.g. "gsd-project-researcher").
    //    Match on meta.agentType + stable chronological order — oldest unclaimed
    //    file with that agentType wins.
    if (!match && agent.subagent_type) {
      match = files.find((f) => !f.claimed && f.meta?.agentType === agent.subagent_type);
    }
    // 4) Same as (3) but allow agent.name to be the subagent_type as a last resort
    if (!match) {
      match = files.find((f) => !f.claimed && f.meta?.agentType === agent.name);
    }

    if (!match) {
      console.log(`[unmatched] ${agent.name.slice(0, 60)}`);
      unmatched++;
      continue;
    }
    match.claimed = true;

    const summary = cache.extractSubagentSummary(match.path);
    if (!summary) {
      console.log(`[no-data] ${agent.name.slice(0, 60)} (empty transcript)`);
      unmatched++;
      continue;
    }

    console.log(
      `[ok] ${agent.name.slice(0, 50).padEnd(50)} → ${summary.primaryModel} (${Object.keys(summary.tokensByModel).length} models)`
    );
    matched++;
    if (!DRY_RUN) update(agent, summary.primaryModel, summary.tokensByModel);
  }
}

// Backfill main agents: their primary model comes from the main session
// transcript (token_usage already has one or more models). Pick the one with
// the most output tokens and mirror it onto the main agent row.
const mainQuery = ONLY_SESSION
  ? "SELECT * FROM agents WHERE type = 'main' AND model IS NULL AND session_id = ?"
  : "SELECT * FROM agents WHERE type = 'main' AND model IS NULL";
const mainRows = ONLY_SESSION
  ? db.prepare(mainQuery).all(ONLY_SESSION)
  : db.prepare(mainQuery).all();
console.log(`\nMain agents without model: ${mainRows.length}`);

const pickMainModel = db.prepare(`
  SELECT model, (output_tokens + baseline_output) as out_total
  FROM token_usage WHERE session_id = ?
  ORDER BY out_total DESC LIMIT 1
`);

let mainMatched = 0;
for (const mainAgent of mainRows) {
  const row = pickMainModel.get(mainAgent.session_id);
  if (!row?.model) continue;
  console.log(`[main] ${mainAgent.id.slice(0, 20).padEnd(20)} → ${row.model}`);
  if (!DRY_RUN) stmts.updateAgentModel.run(row.model, mainAgent.id);
  mainMatched++;
}

console.log(
  `\nDone. Subagents matched: ${matched}/${matched + unmatched}. Main agents: ${mainMatched}/${mainRows.length}${DRY_RUN ? " [DRY RUN — no DB writes]" : ""}`
);
