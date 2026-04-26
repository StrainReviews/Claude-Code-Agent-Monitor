/**
 * @file Express router for session endpoints, allowing creation, retrieval, and updating of sessions with optional pagination and filtering by status. It also computes costs for sessions based on token usage and pricing rules, and broadcasts session changes to connected WebSocket clients for real-time updates.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { stmts, db } = require("../db");
const { broadcast } = require("../websocket");
const { calculateCost } = require("./pricing");

const router = Router();

router.get("/", (req, res) => {
  // Cap raised from 1000 → 10000 so the Sessions and Kanban pages can list
  // realistic deployments without truncation. Cost computation below runs
  // only over the *returned* rows, so it scales with limit (the page size),
  // not with the total session count — server-side pagination keeps each
  // request cheap regardless of how many sessions exist in the DB.
  const limit = Math.min(parseInt(req.query.limit) || 50, 10000);
  const offset = parseInt(req.query.offset) || 0;
  const status = req.query.status;
  const q = typeof req.query.q === "string" ? req.query.q.trim() : "";

  let rows;
  let total;
  if (q) {
    // Search across id, name, cwd — case-insensitive LIKE. Composes with
    // the status filter when present. Output shape (agent_count,
    // last_activity, ordering) matches stmts.listSessions so callers can
    // treat the search result identically.
    const like = `%${q}%`;
    const where = ["(s.id LIKE ? OR s.name LIKE ? OR s.cwd LIKE ?)"];
    const params = [like, like, like];
    if (status) {
      where.push("s.status = ?");
      params.push(status);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;
    rows = db
      .prepare(
        `SELECT s.*, COUNT(a.id) as agent_count, s.updated_at as last_activity
         FROM sessions s LEFT JOIN agents a ON a.session_id = s.id
         ${whereSql}
         GROUP BY s.id ORDER BY s.updated_at DESC LIMIT ? OFFSET ?`
      )
      .all(...params, limit, offset);
    total = db.prepare(`SELECT COUNT(*) as c FROM sessions s ${whereSql}`).get(...params).c;
  } else if (status) {
    rows = stmts.listSessionsByStatus.all(status, limit, offset);
    total = db.prepare("SELECT COUNT(*) as c FROM sessions WHERE status = ?").get(status).c;
  } else {
    rows = stmts.listSessions.all(limit, offset);
    total = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
  }

  // Bulk-compute costs for the returned page only (not the entire matching
  // set). One IN-clause query for token rows, one for pricing rules, then
  // an O(rows) JS pass.
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    const placeholders = ids.map(() => "?").join(",");
    const allTokens = db
      .prepare(
        `SELECT session_id, model,
          input_tokens + baseline_input as input_tokens,
          output_tokens + baseline_output as output_tokens,
          cache_read_tokens + baseline_cache_read as cache_read_tokens,
          cache_write_tokens + baseline_cache_write as cache_write_tokens
        FROM token_usage WHERE session_id IN (${placeholders})`
      )
      .all(...ids);

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

  res.json({ sessions: rows, limit, offset, total });
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

module.exports = router;
