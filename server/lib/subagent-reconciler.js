/**
 * @file Subagent reconciler — periodic drift correction between the Monitor's
 * `subagent_token_usage` / `agents.model` rows and the authoritative JSONL
 * transcripts Claude Code writes under ~/.claude/projects/<encoded>/<sessionId>/subagents/.
 *
 * Why this exists: the live `SubagentStop` hook can mis-route an
 * `agent_transcript_path` onto the wrong agent row when multiple subagents
 * with near-identical names run in parallel (see the "oldest working"
 * fallback in server/routes/hooks.js). The reconciler re-derives the correct
 * Agent <-> JSONL binding from first-line timestamps and repairs the rows.
 *
 * Design invariants:
 *   - One-to-one assignment: each JSONL binds to at most one Agent, each
 *     Agent binds to at most one JSONL per pass.
 *   - Never touches sessions that have no subagent directory on disk.
 *   - Only rewrites rows that actually differ — idempotent.
 *   - Session-scoped transactions so a crash mid-pass leaves the DB consistent.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const DEFAULT_PROJECTS_ROOT = path.join(os.homedir(), ".claude", "projects");

function firstLineMeta(jsonlPath) {
  // Walk forward through the first few KB of the file and return the first
  // entry that has a `timestamp`. Older Claude Code writes the sidechain
  // user-prompt as the first line without a timestamp — only the assistant
  // reply carries it. Also captures sessionId / agentId when present on any
  // of the scanned entries.
  try {
    const stat = fs.statSync(jsonlPath);
    const size = Math.min(65536, stat.size);
    if (size <= 0) return null;
    const buf = Buffer.alloc(size);
    const fd = fs.openSync(jsonlPath, "r");
    try {
      fs.readSync(fd, buf, 0, size, 0);
    } finally {
      fs.closeSync(fd);
    }
    const chunk = buf.toString("utf8");
    // If the buffer ends mid-line, discard the trailing partial line.
    const lines = chunk.split("\n");
    if (chunk.length >= size) lines.pop();
    let ts = null;
    let sessionId = null;
    let agentId = null;
    for (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let j;
      try {
        j = JSON.parse(line);
      } catch {
        continue;
      }
      if (!sessionId && j.sessionId) sessionId = j.sessionId;
      if (!agentId && j.agentId) agentId = j.agentId;
      if (!ts && j.timestamp) {
        ts = j.timestamp;
        break;
      }
    }
    return { ts, sessionId, agentId };
  } catch {
    return null;
  }
}

function safeReadMeta(metaPath) {
  try {
    return JSON.parse(fs.readFileSync(metaPath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Locate the `subagents/` directory that belongs to a session by scanning
 * every encoded project folder under root. Returns the first matching dir
 * (there should be exactly one).
 */
function findSubagentDir(projectsRoot, sessionId) {
  let projects;
  try {
    projects = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const p of projects) {
    if (!p.isDirectory()) continue;
    const candidate = path.join(projectsRoot, p.name, sessionId, "subagents");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * Produce the list of candidate JSONL descriptors for a session's subagents dir.
 * Each descriptor: { jsonl, description, firstTs, firstAgentId }.
 */
function listSubagentJsonls(subDir) {
  let files;
  try {
    files = fs.readdirSync(subDir);
  } catch {
    return [];
  }
  const out = [];
  for (const f of files) {
    if (!f.endsWith(".jsonl")) continue;
    const jsonl = path.join(subDir, f);
    const metaPath = jsonl.replace(/\.jsonl$/, ".meta.json");
    const meta = safeReadMeta(metaPath);
    const first = firstLineMeta(jsonl);
    out.push({
      jsonl,
      description: meta?.description || null,
      agentType: meta?.agentType || null,
      firstTs: first?.ts || null,
      firstAgentId: first?.agentId || null,
    });
  }
  return out;
}

function namesMatch(agentName, description) {
  if (!agentName || !description) return false;
  if (agentName === description) return true;
  const bare = agentName.endsWith("...") ? agentName.slice(0, -3) : agentName;
  if (description.startsWith(bare)) return true;
  if (agentName.startsWith(description.slice(0, 57))) return true;
  return false;
}

/**
 * Greedy one-to-one assignment: for every (agent, jsonl) pair where names
 * match, compute delta = |agent.started_at - jsonl.firstTs|. Sort ascending,
 * assign the tightest pairs first; each agent and each JSONL is consumed at
 * most once.
 */
function assignPairs(agents, jsonls) {
  const candidates = [];
  for (const agent of agents) {
    if (!agent.started_at) continue;
    const target = new Date(agent.started_at).getTime();
    if (Number.isNaN(target)) continue;
    for (const j of jsonls) {
      if (!j.firstTs || !namesMatch(agent.name, j.description)) continue;
      const tts = new Date(j.firstTs).getTime();
      if (Number.isNaN(tts)) continue;
      candidates.push({ agent, jsonl: j, delta: Math.abs(tts - target) });
    }
  }
  candidates.sort((a, b) => a.delta - b.delta);
  const usedAgents = new Set();
  const usedJsonls = new Set();
  const assigned = [];
  for (const c of candidates) {
    if (usedAgents.has(c.agent.id) || usedJsonls.has(c.jsonl.jsonl)) continue;
    usedAgents.add(c.agent.id);
    usedJsonls.add(c.jsonl.jsonl);
    assigned.push({ agent: c.agent, jsonl: c.jsonl, delta: c.delta });
  }
  return assigned;
}

function tokensDiffer(db, agentId, desired) {
  const rows = db
    .prepare(
      `SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM subagent_token_usage WHERE agent_id = ?`
    )
    .all(agentId);
  const have = {};
  for (const r of rows) have[r.model] = r;
  const desiredKeys = Object.keys(desired);
  const haveKeys = Object.keys(have);
  if (desiredKeys.length !== haveKeys.length) return true;
  for (const [model, t] of Object.entries(desired)) {
    const h = have[model];
    if (!h) return true;
    if (
      h.input_tokens !== t.input ||
      h.output_tokens !== t.output ||
      h.cache_read_tokens !== t.cacheRead ||
      h.cache_write_tokens !== t.cacheWrite
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Reconcile a single session. Returns a summary:
 *   { agents, pairs, modelUpdates, tokenUpdates, skipped }
 *
 * `options.dryRun = true` logs would-be changes without writing.
 */
function reconcileSession({ db, stmts, transcriptCache, session, projectsRoot, dryRun = false }) {
  const subDir = findSubagentDir(projectsRoot, session.id);
  if (!subDir) return { sessionId: session.id, reason: "no_subagents_dir", pairs: 0 };

  const agents = stmts.listAgentsBySession.all(session.id).filter((a) => a.type === "subagent");
  if (agents.length === 0) {
    return { sessionId: session.id, reason: "no_subagents", pairs: 0 };
  }

  const jsonls = listSubagentJsonls(subDir);
  if (jsonls.length === 0) {
    return { sessionId: session.id, reason: "empty_subagents_dir", pairs: 0 };
  }

  const pairs = assignPairs(agents, jsonls);

  let modelUpdates = 0;
  let tokenUpdates = 0;
  const changes = [];

  const applyOne = (agent, jsonl) => {
    const summary = transcriptCache.extractSubagentSummary(jsonl.jsonl);
    if (!summary) return;

    // Model update if it differs
    if (agent.model !== summary.primaryModel) {
      if (!dryRun) stmts.updateAgentModel.run(summary.primaryModel, agent.id);
      modelUpdates++;
      changes.push({
        agent_id: agent.id,
        kind: "model",
        from: agent.model,
        to: summary.primaryModel,
      });
    }

    // Token rows update if any field differs OR the set of models differs
    if (tokensDiffer(db, agent.id, summary.tokensByModel)) {
      if (!dryRun) {
        // Delete any stale (model) rows that no longer appear in truth
        const modelsNow = Object.keys(summary.tokensByModel);
        const placeholders = modelsNow.map(() => "?").join(",");
        if (modelsNow.length > 0) {
          db.prepare(
            `DELETE FROM subagent_token_usage WHERE agent_id = ? AND model NOT IN (${placeholders})`
          ).run(agent.id, ...modelsNow);
        } else {
          db.prepare(`DELETE FROM subagent_token_usage WHERE agent_id = ?`).run(agent.id);
        }
        // Upsert all desired rows
        for (const [model, t] of Object.entries(summary.tokensByModel)) {
          stmts.replaceSubagentTokens.run(
            agent.id,
            session.id,
            model,
            t.input,
            t.output,
            t.cacheRead,
            t.cacheWrite
          );
        }
      }
      tokenUpdates++;
      changes.push({
        agent_id: agent.id,
        kind: "tokens",
        models: Object.keys(summary.tokensByModel),
      });
    }
  };

  const runAll = () => {
    for (const { agent, jsonl } of pairs) applyOne(agent, jsonl);
  };

  if (dryRun) {
    runAll();
  } else {
    db.transaction(runAll)();
  }

  return {
    sessionId: session.id,
    pairs: pairs.length,
    agents: agents.length,
    jsonls: jsonls.length,
    modelUpdates,
    tokenUpdates,
    changes,
  };
}

/**
 * Reconcile all sessions (optionally filtered). Returns an aggregate report.
 *
 * Filter default: sessions that were active within the last 24h OR are still
 * status='active'. This keeps periodic passes cheap while still repairing
 * anything a user might currently be looking at.
 */
function reconcileAll({
  db,
  stmts,
  transcriptCache,
  projectsRoot = DEFAULT_PROJECTS_ROOT,
  dryRun = false,
  sessionFilter = null,
  now = Date.now(),
  maxAgeMs = 24 * 60 * 60 * 1000,
}) {
  const candidates = db
    .prepare(
      `SELECT * FROM sessions
        WHERE status = 'active'
           OR updated_at >= ?`
    )
    .all(new Date(now - maxAgeMs).toISOString());
  const sessions = sessionFilter
    ? candidates.filter((s) => sessionFilter.includes(s.id))
    : candidates;

  const results = [];
  let totalModelUpdates = 0;
  let totalTokenUpdates = 0;
  let sessionsChanged = 0;

  for (const s of sessions) {
    const r = reconcileSession({
      db,
      stmts,
      transcriptCache,
      session: s,
      projectsRoot,
      dryRun,
    });
    results.push(r);
    totalModelUpdates += r.modelUpdates || 0;
    totalTokenUpdates += r.tokenUpdates || 0;
    if ((r.modelUpdates || 0) + (r.tokenUpdates || 0) > 0) sessionsChanged++;
  }

  return {
    dryRun,
    sessionsScanned: sessions.length,
    sessionsChanged,
    totalModelUpdates,
    totalTokenUpdates,
    results,
  };
}

module.exports = {
  reconcileSession,
  reconcileAll,
  DEFAULT_PROJECTS_ROOT,
  // Internals exported for testing
  _internals: { firstLineMeta, listSubagentJsonls, assignPairs, namesMatch },
};
