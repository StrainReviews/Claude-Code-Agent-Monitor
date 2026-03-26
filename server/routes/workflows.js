const { Router } = require("express");
const { db, stmts } = require("../db");

const router = Router();

// ── Helper: compute session duration in seconds ──
function durationSec(s) {
  if (!s.started_at) return 0;
  const end = s.ended_at || new Date().toISOString();
  return Math.max(0, (new Date(end) - new Date(s.started_at)) / 1000);
}

// ── GET / — Aggregate workflow intelligence ──
router.get("/", (_req, res) => {
  try {
    const data = {
      stats: getWorkflowStats(),
      orchestration: getOrchestrationData(),
      toolFlow: getToolFlowData(),
      effectiveness: getSubagentEffectiveness(),
      patterns: getWorkflowPatterns(),
      modelDelegation: getModelDelegation(),
      errorPropagation: getErrorPropagation(),
      concurrency: getConcurrencyData(),
      complexity: getSessionComplexity(),
      compaction: getCompactionImpact(),
      cooccurrence: getAgentCooccurrence(),
    };
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ── GET /session/:id — Single session drill-in ──
router.get("/session/:id", (req, res) => {
  try {
    const sessionId = req.params.id;
    const session = stmts.getSession.get(sessionId);
    if (!session) return res.status(404).json({ error: { message: "Session not found" } });

    const agents = stmts.listAgentsBySession.all(sessionId);
    const events = db
      .prepare("SELECT * FROM events WHERE session_id = ? ORDER BY created_at ASC, id ASC")
      .all(sessionId);

    // Build agent tree
    const tree = buildAgentTree(agents);

    // Build tool timeline
    const toolTimeline = events
      .filter((e) => e.tool_name)
      .map((e) => ({
        id: e.id,
        tool_name: e.tool_name,
        event_type: e.event_type,
        agent_id: e.agent_id,
        created_at: e.created_at,
        summary: e.summary,
      }));

    // Agent swim lanes
    const swimLanes = agents.map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      subagent_type: a.subagent_type,
      status: a.status,
      started_at: a.started_at,
      ended_at: a.ended_at,
      parent_agent_id: a.parent_agent_id,
    }));

    res.json({ session, tree, toolTimeline, swimLanes, events: events.slice(0, 500) });
  } catch (err) {
    res.status(500).json({ error: { message: err.message } });
  }
});

// ═══════════════════════════════════════════════════
// Data-fetching functions
// ═══════════════════════════════════════════════════

function getWorkflowStats() {
  const totalSessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
  const totalAgents = db.prepare("SELECT COUNT(*) as c FROM agents").get().c;
  const totalSubagents = db
    .prepare("SELECT COUNT(*) as c FROM agents WHERE type = 'subagent'")
    .get().c;

  // Average subagents per session
  const avgSubagents = totalSessions > 0 ? +(totalSubagents / totalSessions).toFixed(1) : 0;

  // Agent success rate
  const completedAgents = db
    .prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'completed'")
    .get().c;
  const errorAgents = db.prepare("SELECT COUNT(*) as c FROM agents WHERE status = 'error'").get().c;
  const finishedAgents = completedAgents + errorAgents;
  const successRate =
    finishedAgents > 0 ? +((completedAgents / finishedAgents) * 100).toFixed(1) : 100;

  // Average max depth per session
  const depthRows = db
    .prepare(
      `WITH RECURSIVE agent_depth AS (
        SELECT id, session_id, parent_agent_id, 0 as depth FROM agents WHERE parent_agent_id IS NULL
        UNION ALL
        SELECT a.id, a.session_id, a.parent_agent_id, ad.depth + 1
        FROM agents a JOIN agent_depth ad ON a.parent_agent_id = ad.id
      )
      SELECT session_id, MAX(depth) as max_depth FROM agent_depth GROUP BY session_id`
    )
    .all();
  const avgDepth =
    depthRows.length > 0
      ? +(depthRows.reduce((s, r) => s + r.max_depth, 0) / depthRows.length).toFixed(1)
      : 0;

  // Average session duration
  const sessions = db
    .prepare("SELECT started_at, ended_at FROM sessions WHERE ended_at IS NOT NULL")
    .all();
  const totalDuration = sessions.reduce((s, sess) => s + durationSec(sess), 0);
  const avgDurationSec = sessions.length > 0 ? Math.round(totalDuration / sessions.length) : 0;

  // Total compactions
  const totalCompactions = db
    .prepare("SELECT COUNT(*) as c FROM agents WHERE subagent_type = 'compaction'")
    .get().c;
  const avgCompactions = totalSessions > 0 ? +(totalCompactions / totalSessions).toFixed(1) : 0;

  // Most common tool flow (top 2-tool sequence)
  const topFlow = db
    .prepare(
      `SELECT e1.tool_name as source, e2.tool_name as target, COUNT(*) as c
       FROM events e1
       JOIN events e2 ON e2.session_id = e1.session_id AND e2.id = (
         SELECT MIN(e3.id) FROM events e3
         WHERE e3.session_id = e1.session_id AND e3.id > e1.id AND e3.tool_name IS NOT NULL
       )
       WHERE e1.tool_name IS NOT NULL AND e2.tool_name IS NOT NULL
       GROUP BY e1.tool_name, e2.tool_name
       ORDER BY c DESC LIMIT 1`
    )
    .get();

  return {
    totalSessions,
    totalAgents,
    totalSubagents,
    avgSubagents,
    successRate,
    avgDepth,
    avgDurationSec,
    totalCompactions,
    avgCompactions,
    topFlow: topFlow ? { source: topFlow.source, target: topFlow.target, count: topFlow.c } : null,
  };
}

function getOrchestrationData() {
  // Count sessions
  const sessionCount = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;

  // Main agents count
  const mainCount = db.prepare("SELECT COUNT(*) as c FROM agents WHERE type = 'main'").get().c;

  // Subagent types with counts and parent info
  const subagentTypes = db
    .prepare(
      `SELECT subagent_type, COUNT(*) as count,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN status = 'error' THEN 1 ELSE 0 END) as errors
       FROM agents WHERE type = 'subagent' AND subagent_type IS NOT NULL
       GROUP BY subagent_type ORDER BY count DESC`
    )
    .all();

  // Edges: parent_subagent_type -> child_subagent_type with frequency
  const edges = db
    .prepare(
      `SELECT
        COALESCE(p.subagent_type, 'main') as source,
        a.subagent_type as target,
        COUNT(*) as weight
       FROM agents a
       LEFT JOIN agents p ON a.parent_agent_id = p.id
       WHERE a.type = 'subagent' AND a.subagent_type IS NOT NULL
       GROUP BY source, target
       ORDER BY weight DESC`
    )
    .all();

  // Outcome counts
  const outcomes = db
    .prepare(
      `SELECT status, COUNT(*) as count FROM agents
       WHERE status IN ('completed', 'error')
       GROUP BY status`
    )
    .all();

  // Compaction agents (context compressions per session)
  const compactions = db
    .prepare(
      `SELECT session_id, COUNT(*) as count
       FROM agents WHERE subagent_type = 'compaction'
       GROUP BY session_id`
    )
    .all();
  const totalCompactions = compactions.reduce((s, r) => s + r.count, 0);
  const sessionsWithCompactions = compactions.length;

  return {
    sessionCount,
    mainCount,
    subagentTypes,
    edges,
    outcomes,
    compactions: { total: totalCompactions, sessions: sessionsWithCompactions },
  };
}

function getToolFlowData() {
  // Tool-to-tool transitions (next tool in same session)
  const transitions = db
    .prepare(
      `SELECT e1.tool_name as source, e2.tool_name as target, COUNT(*) as value
       FROM events e1
       JOIN events e2 ON e2.session_id = e1.session_id AND e2.id = (
         SELECT MIN(e3.id) FROM events e3
         WHERE e3.session_id = e1.session_id AND e3.id > e1.id AND e3.tool_name IS NOT NULL
       )
       WHERE e1.tool_name IS NOT NULL AND e2.tool_name IS NOT NULL
       GROUP BY e1.tool_name, e2.tool_name
       ORDER BY value DESC
       LIMIT 50`
    )
    .all();

  // Tool counts for sizing nodes
  const toolCounts = db
    .prepare(
      `SELECT tool_name, COUNT(*) as count FROM events
       WHERE tool_name IS NOT NULL
       GROUP BY tool_name ORDER BY count DESC LIMIT 15`
    )
    .all();

  return { transitions, toolCounts };
}

function getSubagentEffectiveness() {
  const types = db
    .prepare(
      `SELECT
        a.subagent_type,
        COUNT(*) as total,
        SUM(CASE WHEN a.status = 'completed' THEN 1 ELSE 0 END) as completed,
        SUM(CASE WHEN a.status = 'error' THEN 1 ELSE 0 END) as errors,
        COUNT(DISTINCT a.session_id) as sessions
       FROM agents a
       WHERE a.type = 'subagent' AND a.subagent_type IS NOT NULL
       GROUP BY a.subagent_type
       ORDER BY total DESC
       LIMIT 12`
    )
    .all();

  // Get token usage per subagent type (approximate via session token totals)
  // Also get average duration per type
  const withMetrics = types.map((t) => {
    const durRow = db
      .prepare(
        `SELECT AVG(
          CASE WHEN ended_at IS NOT NULL THEN
            (julianday(ended_at) - julianday(started_at)) * 86400
          ELSE NULL END
        ) as avg_duration
        FROM agents WHERE subagent_type = ? AND type = 'subagent'`
      )
      .get(t.subagent_type);

    // Weekly trend: count per week for last 8 weeks
    const trend = db
      .prepare(
        `SELECT strftime('%Y-W%W', started_at) as week, COUNT(*) as count
         FROM agents WHERE subagent_type = ? AND type = 'subagent'
           AND started_at >= date('now', '-56 days')
         GROUP BY week ORDER BY week ASC`
      )
      .all(t.subagent_type);

    return {
      ...t,
      successRate:
        t.completed + t.errors > 0
          ? +((t.completed / (t.completed + t.errors)) * 100).toFixed(1)
          : 100,
      avgDuration: durRow?.avg_duration ? Math.round(durRow.avg_duration) : null,
      trend: trend.map((w) => w.count),
    };
  });

  return withMetrics;
}

function getWorkflowPatterns() {
  // Get ordered subagent sequences per session
  const sessions = db
    .prepare(
      `SELECT session_id, GROUP_CONCAT(subagent_type, '→') as sequence
       FROM (
         SELECT session_id, subagent_type
         FROM agents
         WHERE type = 'subagent' AND subagent_type IS NOT NULL
         ORDER BY session_id, started_at ASC
       )
       GROUP BY session_id
       HAVING COUNT(*) >= 2`
    )
    .all();

  // Count pattern frequencies
  const patternCounts = {};
  const totalSessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;
  for (const row of sessions) {
    const seq = row.sequence;
    patternCounts[seq] = (patternCounts[seq] || 0) + 1;
  }

  // Also count 2-step and 3-step sub-patterns
  for (const row of sessions) {
    const steps = row.sequence.split("→");
    // 2-step windows
    for (let i = 0; i < steps.length - 1; i++) {
      const sub = steps.slice(i, i + 2).join("→");
      patternCounts[sub] = (patternCounts[sub] || 0) + 1;
    }
    // 3-step windows
    for (let i = 0; i < steps.length - 2; i++) {
      const sub = steps.slice(i, i + 3).join("→");
      patternCounts[sub] = (patternCounts[sub] || 0) + 1;
    }
  }

  // Deduplicate: keep only patterns where the full sequence count >= 2-step count
  // Sort by frequency, take top 10
  const sorted = Object.entries(patternCounts)
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([pattern, count]) => ({
      steps: pattern.split("→"),
      count,
      percentage: totalSessions > 0 ? +((count / totalSessions) * 100).toFixed(1) : 0,
    }));

  // Also track solo sessions (no subagents)
  const soloCount = db
    .prepare(
      `SELECT COUNT(*) as c FROM sessions s
       WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.session_id = s.id AND a.type = 'subagent')`
    )
    .get().c;

  return {
    patterns: sorted,
    soloSessionCount: soloCount,
    soloPercentage: totalSessions > 0 ? +((soloCount / totalSessions) * 100).toFixed(1) : 0,
  };
}

function getModelDelegation() {
  // Model usage for main agents
  const mainModels = db
    .prepare(
      `SELECT s.model, COUNT(DISTINCT a.id) as agent_count, COUNT(DISTINCT s.id) as session_count
       FROM agents a JOIN sessions s ON a.session_id = s.id
       WHERE a.type = 'main' AND s.model IS NOT NULL
       GROUP BY s.model ORDER BY agent_count DESC`
    )
    .all();

  // Model usage for subagents (via session model — best approximation)
  const subagentModels = db
    .prepare(
      `SELECT s.model, COUNT(a.id) as agent_count
       FROM agents a JOIN sessions s ON a.session_id = s.id
       WHERE a.type = 'subagent' AND s.model IS NOT NULL
       GROUP BY s.model ORDER BY agent_count DESC`
    )
    .all();

  // Token cost per model
  const tokensByModel = db
    .prepare(
      `SELECT model,
        SUM(input_tokens + baseline_input) as input_tokens,
        SUM(output_tokens + baseline_output) as output_tokens,
        SUM(cache_read_tokens + baseline_cache_read) as cache_read_tokens,
        SUM(cache_write_tokens + baseline_cache_write) as cache_write_tokens
       FROM token_usage GROUP BY model ORDER BY (input_tokens + output_tokens) DESC`
    )
    .all();

  return { mainModels, subagentModels, tokensByModel };
}

function getErrorPropagation() {
  // Error count by depth
  const errorsByDepth = db
    .prepare(
      `WITH RECURSIVE agent_depth AS (
        SELECT id, session_id, subagent_type, status, 0 as depth
        FROM agents WHERE parent_agent_id IS NULL
        UNION ALL
        SELECT a.id, a.session_id, a.subagent_type, a.status, ad.depth + 1
        FROM agents a JOIN agent_depth ad ON a.parent_agent_id = ad.id
      )
      SELECT depth, COUNT(*) as count FROM agent_depth
      WHERE status = 'error'
      GROUP BY depth ORDER BY depth ASC`
    )
    .all();

  // Error-prone subagent types
  const errorTypes = db
    .prepare(
      `SELECT subagent_type, COUNT(*) as count
       FROM agents WHERE status = 'error' AND subagent_type IS NOT NULL
       GROUP BY subagent_type ORDER BY count DESC LIMIT 5`
    )
    .all();

  // Error rate per session (sessions with errors vs total)
  const sessionsWithErrors = db
    .prepare(`SELECT COUNT(DISTINCT session_id) as c FROM agents WHERE status = 'error'`)
    .get().c;
  const totalSessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;

  return {
    byDepth: errorsByDepth,
    byType: errorTypes,
    sessionsWithErrors,
    totalSessions,
    errorRate: totalSessions > 0 ? +((sessionsWithErrors / totalSessions) * 100).toFixed(1) : 0,
  };
}

function getConcurrencyData() {
  // For aggregate: average agent types per position in session timeline
  // Get agent start/end as fraction of session duration per session
  const lanes = db
    .prepare(
      `SELECT
        a.id, a.name, a.type, a.subagent_type, a.status,
        a.started_at, a.ended_at, a.session_id,
        s.started_at as session_start, s.ended_at as session_end
       FROM agents a
       JOIN sessions s ON a.session_id = s.id
       WHERE s.ended_at IS NOT NULL
       ORDER BY a.started_at ASC
       LIMIT 2000`
    )
    .all();

  // Build aggregate: for each subagent_type, average start% and end%
  const typeAgg = {};
  for (const lane of lanes) {
    const sessStart = new Date(lane.session_start).getTime();
    const sessEnd = new Date(lane.session_end).getTime();
    const sessDur = sessEnd - sessStart;
    if (sessDur <= 0) continue;

    const agStart = new Date(lane.started_at).getTime();
    const agEnd = lane.ended_at ? new Date(lane.ended_at).getTime() : sessEnd;

    const startPct = Math.max(0, Math.min(1, (agStart - sessStart) / sessDur));
    const endPct = Math.max(0, Math.min(1, (agEnd - sessStart) / sessDur));

    const key = lane.type === "main" ? "Main Agent" : lane.subagent_type || "unknown";
    if (!typeAgg[key]) typeAgg[key] = { starts: [], ends: [], status: lane.status };
    typeAgg[key].starts.push(startPct);
    typeAgg[key].ends.push(endPct);
  }

  // Average start/end per type
  const aggregateLanes = Object.entries(typeAgg)
    .map(([name, data]) => ({
      name,
      avgStart: +(data.starts.reduce((s, v) => s + v, 0) / data.starts.length).toFixed(3),
      avgEnd: +(data.ends.reduce((s, v) => s + v, 0) / data.ends.length).toFixed(3),
      count: data.starts.length,
    }))
    .sort((a, b) => a.avgStart - b.avgStart);

  return { aggregateLanes };
}

function getSessionComplexity() {
  const rows = db
    .prepare(
      `SELECT
        s.id, s.name, s.status, s.started_at, s.ended_at, s.model,
        COUNT(a.id) as agent_count,
        SUM(CASE WHEN a.type = 'subagent' THEN 1 ELSE 0 END) as subagent_count
       FROM sessions s
       LEFT JOIN agents a ON a.session_id = s.id
       GROUP BY s.id
       ORDER BY s.started_at DESC
       LIMIT 200`
    )
    .all();

  const sessions = rows.map((r) => {
    const dur = durationSec(r);
    // Get token count for this session
    const tokens = db
      .prepare(
        `SELECT SUM(input_tokens + baseline_input + output_tokens + baseline_output +
                    cache_read_tokens + baseline_cache_read + cache_write_tokens + baseline_cache_write) as total
         FROM token_usage WHERE session_id = ?`
      )
      .get(r.id);

    return {
      id: r.id,
      name: r.name,
      status: r.status,
      duration: Math.round(dur),
      agentCount: r.agent_count,
      subagentCount: r.subagent_count,
      totalTokens: tokens?.total || 0,
      model: r.model,
    };
  });

  return sessions;
}

function getCompactionImpact() {
  // Total compactions
  const totalCompactions = db
    .prepare("SELECT COUNT(*) as c FROM agents WHERE subagent_type = 'compaction'")
    .get().c;

  // Total baseline tokens (tokens "recovered" through compaction)
  const recovered = db
    .prepare(
      `SELECT
        SUM(baseline_input + baseline_output + baseline_cache_read + baseline_cache_write) as total
       FROM token_usage`
    )
    .get();

  // Compactions per session distribution
  const perSession = db
    .prepare(
      `SELECT session_id, COUNT(*) as compactions
       FROM agents WHERE subagent_type = 'compaction'
       GROUP BY session_id ORDER BY compactions DESC LIMIT 50`
    )
    .all();

  // Sessions with compactions vs without
  const sessionsWithCompactions = db
    .prepare(
      `SELECT COUNT(DISTINCT session_id) as c FROM agents WHERE subagent_type = 'compaction'`
    )
    .get().c;
  const totalSessions = db.prepare("SELECT COUNT(*) as c FROM sessions").get().c;

  return {
    totalCompactions,
    tokensRecovered: recovered?.total || 0,
    perSession,
    sessionsWithCompactions,
    totalSessions,
  };
}

function getAgentCooccurrence() {
  // Directed: which agent type runs AFTER which other type in the same session
  // a1 started before a2 → edge a1 → a2 with count
  const pairs = db
    .prepare(
      `SELECT a1.subagent_type as source, a2.subagent_type as target,
              COUNT(*) as weight
       FROM agents a1
       JOIN agents a2 ON a1.session_id = a2.session_id
         AND a1.started_at < a2.started_at
         AND a1.id != a2.id
       WHERE a1.type = 'subagent' AND a2.type = 'subagent'
         AND a1.subagent_type IS NOT NULL AND a2.subagent_type IS NOT NULL
         AND a1.subagent_type != 'compaction' AND a2.subagent_type != 'compaction'
       GROUP BY a1.subagent_type, a2.subagent_type
       HAVING weight >= 2
       ORDER BY weight DESC
       LIMIT 40`
    )
    .all();

  return pairs;
}

// ── Build agent tree from flat list ──
function buildAgentTree(agents) {
  const map = {};
  const roots = [];
  for (const a of agents) {
    map[a.id] = {
      id: a.id,
      name: a.name,
      type: a.type,
      subagent_type: a.subagent_type,
      status: a.status,
      task: a.task,
      started_at: a.started_at,
      ended_at: a.ended_at,
      children: [],
    };
  }
  for (const a of agents) {
    if (a.parent_agent_id && map[a.parent_agent_id]) {
      map[a.parent_agent_id].children.push(map[a.id]);
    } else {
      roots.push(map[a.id]);
    }
  }
  return roots;
}

module.exports = router;
