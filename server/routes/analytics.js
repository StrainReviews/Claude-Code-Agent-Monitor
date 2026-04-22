/**
 * @file Express router for analytics endpoints, providing aggregated statistics on token usage, tool usage, daily events/sessions, agent types, and more. It queries the database for various metrics and returns them in a structured JSON format for frontend consumption.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { stmts, db } = require("../db");

const { calculateCost } = require("./pricing");

const router = Router();

router.get("/", (_req, res) => {
  const tokenTotals = stmts.getTokenTotals.get();
  const toolUsage = stmts.toolUsageCounts.all();
  const dailyEvents = stmts.dailyEventCounts.all();
  const dailySessions = stmts.dailySessionCounts.all();
  const agentTypes = stmts.agentTypeDistribution.all();
  const overview = stmts.stats.get();
  const agentsByStatus = stmts.agentStatusCounts.all();
  const sessionsByStatus = stmts.sessionStatusCounts.all();
  const totalSubagents = stmts.totalSubagentCount.get();
  const eventTypes = stmts.eventTypeCounts.all();
  const avgEvents = stmts.avgEventsPerSession.get();

  // Calculate total cost across all sessions. Combine main-session token_usage
  // (with compaction baselines) and per-subagent subagent_token_usage — the
  // two source sets are disjoint (different JSONL files), so additive
  // summation per (session, model) yields correct costs without subtraction.
  const pricingRules = stmts.listPricing.all();
  const allTokenUsage = db
    .prepare(
      `SELECT model,
         SUM(input_tokens)       as input_tokens,
         SUM(output_tokens)      as output_tokens,
         SUM(cache_read_tokens)  as cache_read_tokens,
         SUM(cache_write_tokens) as cache_write_tokens
       FROM (
         SELECT model,
           input_tokens + baseline_input       as input_tokens,
           output_tokens + baseline_output     as output_tokens,
           cache_read_tokens + baseline_cache_read  as cache_read_tokens,
           cache_write_tokens + baseline_cache_write as cache_write_tokens
         FROM token_usage
         UNION ALL
         SELECT model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
         FROM subagent_token_usage
       )
       GROUP BY model`
    )
    .all();

  let totalCost = 0;
  for (const usage of allTokenUsage) {
    const { total_cost } = calculateCost([usage], pricingRules);
    totalCost += total_cost;
  }

  res.json({
    tokens: {
      total_input: tokenTotals?.total_input ?? 0,
      total_output: tokenTotals?.total_output ?? 0,
      total_cache_read: tokenTotals?.total_cache_read ?? 0,
      total_cache_write: tokenTotals?.total_cache_write ?? 0,
    },
    total_cost: totalCost,
    tool_usage: toolUsage,
    daily_events: dailyEvents,
    daily_sessions: dailySessions,
    agent_types: agentTypes,
    event_types: eventTypes,
    avg_events_per_session: avgEvents?.avg ?? 0,
    total_subagents: totalSubagents?.count ?? 0,
    overview,
    agents_by_status: Object.fromEntries(agentsByStatus.map((r) => [r.status, r.count])),
    sessions_by_status: Object.fromEntries(sessionsByStatus.map((r) => [r.status, r.count])),
  });
});

module.exports = router;
