/**
 * @file Express router for session endpoints, allowing creation, retrieval, and updating of sessions with optional pagination and filtering by status. It also computes costs for sessions based on token usage and pricing rules, and broadcasts session changes to connected WebSocket clients for real-time updates.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { stmts, db } = require("../db");
const { broadcast } = require("../websocket");
const { calculateCost } = require("./pricing");
const { reconcileSession, reconcileAll } = require("../lib/subagent-reconciler");
const { transcriptCache } = require("./hooks");

const router = Router();

router.get("/", (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 50, 1000);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;

  const rows = status
    ? stmts.listSessionsByStatus.all(status, limit, offset)
    : stmts.listSessions.all(limit, offset);

  // Bulk-compute costs for all returned sessions in a single pass
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    // Combine main-session tokens (token_usage, baselines applied) with
    // per-subagent tokens (subagent_token_usage). Subagent transcripts are
    // disjoint from the main transcript so additive summation is correct.
    const allTokens = db
      .prepare(
        `SELECT session_id, model,
          SUM(input_tokens)       as input_tokens,
          SUM(output_tokens)      as output_tokens,
          SUM(cache_read_tokens)  as cache_read_tokens,
          SUM(cache_write_tokens) as cache_write_tokens
        FROM (
          SELECT session_id, model,
            input_tokens + baseline_input       as input_tokens,
            output_tokens + baseline_output     as output_tokens,
            cache_read_tokens + baseline_cache_read  as cache_read_tokens,
            cache_write_tokens + baseline_cache_write as cache_write_tokens
          FROM token_usage WHERE session_id IN (${placeholders})
          UNION ALL
          SELECT session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
          FROM subagent_token_usage WHERE session_id IN (${placeholders})
        )
        GROUP BY session_id, model`
      )
      .all(...ids, ...ids);

    const rules = stmts.listPricing.all();
    const tokensBySession = {};
    for (const t of allTokens) {
      if (!tokensBySession[t.session_id]) tokensBySession[t.session_id] = [];
      tokensBySession[t.session_id].push(t);
    }

    for (const row of rows) {
      const sessionTokens = tokensBySession[row.id];
      if (sessionTokens) {
        row.cost = calculateCost(sessionTokens, rules).total_cost;
      } else {
        row.cost = 0;
      }
    }
  }

  res.json({ sessions: rows, limit, offset });
});

router.get("/:id", (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }
  const agents = stmts.listAgentsBySession.all(req.params.id);
  const events = stmts.listEventsBySession.all(req.params.id);
  res.json({ session, agents, events });
});

router.post("/", (req, res) => {
  const { id, name, cwd, model, metadata } = req.body;
  if (!id) {
    return res.status(400).json({ error: { code: "INVALID_INPUT", message: "id is required" } });
  }

  const existing = stmts.getSession.get(id);
  if (existing) {
    return res.json({ session: existing, created: false });
  }

  stmts.insertSession.run(
    id,
    name || null,
    "active",
    cwd || null,
    model || null,
    metadata ? JSON.stringify(metadata) : null
  );
  const session = stmts.getSession.get(id);
  broadcast("session_created", session);
  res.status(201).json({ session, created: true });
});

router.patch("/:id", (req, res) => {
  const { name, status, ended_at, metadata } = req.body;
  const existing = stmts.getSession.get(req.params.id);
  if (!existing) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  stmts.updateSession.run(
    name || null,
    status || null,
    ended_at || null,
    metadata ? JSON.stringify(metadata) : null,
    req.params.id
  );

  const session = stmts.getSession.get(req.params.id);
  broadcast("session_updated", session);
  res.json({ session });
});

// On-demand subagent reconciliation. Re-derives the correct Agent <-> JSONL
// binding from first-line timestamps and repairs any drift in
// `subagent_token_usage` / `agents.model`. Safe to call repeatedly.
// Query `dry_run=1` returns the would-be changes without writing.
router.post("/:id/reconcile", (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }
  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  try {
    const result = reconcileSession({
      db,
      stmts,
      transcriptCache,
      session,
      projectsRoot:
        process.env.CLAUDE_PROJECTS_ROOT ||
        require("path").join(require("os").homedir(), ".claude", "projects"),
      dryRun,
    });
    if (!dryRun && (result.modelUpdates > 0 || result.tokenUpdates > 0)) {
      broadcast("session_updated", stmts.getSession.get(req.params.id));
    }
    res.json({ ok: true, dry_run: dryRun, result });
  } catch (e) {
    res.status(500).json({ error: { code: "RECONCILE_FAILED", message: e.message } });
  }
});

// Run the reconciler across every recent/active session in one call.
router.post("/reconcile-all", (req, res) => {
  const dryRun = req.query.dry_run === "1" || req.query.dry_run === "true";
  try {
    const result = reconcileAll({
      db,
      stmts,
      transcriptCache,
      projectsRoot:
        process.env.CLAUDE_PROJECTS_ROOT ||
        require("path").join(require("os").homedir(), ".claude", "projects"),
      dryRun,
    });
    res.json({ ok: true, dry_run: dryRun, result });
  } catch (e) {
    res.status(500).json({ error: { code: "RECONCILE_FAILED", message: e.message } });
  }
});

module.exports = router;
