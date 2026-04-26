/**
 * @file Express router for session endpoints, allowing creation, retrieval, and updating of sessions with optional pagination and filtering by status. It also computes costs for sessions based on token usage and pricing rules, and broadcasts session changes to connected WebSocket clients for real-time updates.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const fs = require("fs");
const path = require("path");
const readline = require("readline");
const { stmts, db } = require("../db");
const { broadcast } = require("../websocket");
const { calculateCost } = require("./pricing");
const {
  getClaudeHome,
  getProjectsDir,
  getTranscriptPath,
  getSubagentTranscriptPath,
  findTranscriptPath,
  findSubagentTranscriptPath,
} = require("../lib/claude-home");

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

// GET /:id/transcripts — List available transcript files for a session (main + sub-agents)
router.get("/:id/transcripts", (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const result = [];

  // Query database agent list for db_agent_id association
  const dbAgents = stmts.listAgentsBySession.all(req.params.id) || [];

  // Main session transcript
  const mainPath = getTranscriptPath(req.params.id, session.cwd) || findTranscriptPath(req.params.id);
  if (mainPath && fs.existsSync(mainPath)) {
    // Main agent database ID format: <sessionId>-main
    const mainDbAgent = dbAgents.find((a) => a.type === "main");
    result.push({
      id: "main",
      name: "Main Agent",
      type: "main",
      has_transcript: true,
      db_agent_id: mainDbAgent ? mainDbAgent.id : null,
    });
  }

  // Sub-agent transcript files
  const encoded = session.cwd ? session.cwd.replace(/[^a-zA-Z0-9]/g, "-") : null;
  const subagentDirs = [];

  // Direct path
  if (encoded) {
    const directDir = path.join(getProjectsDir(), encoded, req.params.id, "subagents");
    if (fs.existsSync(directDir)) subagentDirs.push(directDir);
  }

  // Fallback: scan all project directories when direct path doesn't exist
  if (subagentDirs.length === 0) {
    const projectsDir = path.join(getClaudeHome(), "projects");
    if (fs.existsSync(projectsDir)) {
      try {
        for (const d of fs.readdirSync(projectsDir, { withFileTypes: true })) {
          if (!d.isDirectory()) continue;
          const candidate = path.join(projectsDir, d.name, req.params.id, "subagents");
          if (fs.existsSync(candidate)) subagentDirs.push(candidate);
        }
      } catch { /* ignore */ }
    }
  }

  for (const dir of subagentDirs) {
    try {
      const files = fs.readdirSync(dir);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        // File name format: agent-<shortId>.jsonl
        const shortId = file.replace(/^agent-/, "").replace(/\.jsonl$/, "");
        // Try reading meta.json for agent type info
        let meta = null;
        const metaPath = path.join(dir, file.replace(".jsonl", ".meta.json"));
        if (fs.existsSync(metaPath)) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, "utf8")); } catch { /* ignore */ }
        }

        const isCompact = shortId.startsWith("acompact-");
        const transcriptName = isCompact
          ? "Context Compaction"
          : (meta?.description || meta?.agentType || shortId);
        const transcriptSubagentType = meta?.agentType || null;

        // Match database agent: best-effort matching using subagent_type + name
        let dbAgentId = null;
        if (isCompact) {
          // Compaction type: match agents with subagent_type=compaction
          const compactAgents = dbAgents.filter((a) => a.subagent_type === "compaction");
          // Try matching compact agent UUID using hex portion from shortId
          // Database ID format: <sessionId>-compact-<uuid>
          const compactHex = shortId.replace("acompact-", "");
          for (const a of compactAgents) {
            const dbUuid = (a.id.match(/compact-([0-9a-f-]+)$/) || [])[1];
            if (dbUuid) {
              // Compare hex with hyphens removed for containment
              const dbHex = dbUuid.replace(/-/g, "");
              if (dbHex.includes(compactHex) || compactHex.includes(dbHex.slice(0, 16))) {
                dbAgentId = a.id;
                break;
              }
            }
          }
        } else {
          // Non-compact sub-agents: match by subagent_type + name
          let matched = dbAgents.filter((a) => a.type === "subagent");
          if (transcriptSubagentType) {
            const byType = matched.filter((a) => a.subagent_type === transcriptSubagentType);
            if (byType.length > 0) matched = byType;
          }
          if (transcriptName && matched.length > 1) {
            const byName = matched.filter((a) => a.name === transcriptName);
            if (byName.length > 0) matched = byName;
          }
          if (matched.length > 0) dbAgentId = matched[0].id;
        }

        result.push({
          id: shortId,
          name: transcriptName,
          type: isCompact ? "compaction" : "subagent",
          subagent_type: transcriptSubagentType,
          has_transcript: true,
          db_agent_id: dbAgentId,
        });
      }
    } catch { /* ignore */ }
  }

  res.json({ transcripts: result });
});

// GET /:id/transcript — Read session JSONL transcript, return structured message list
// Query params:
//   agent_id: file-level short ID ("main" or "ad18a79192af10ed1", "acompact-xxx")
//   limit: max messages to return (default 50, max 200)
//   after: JSONL line number, only return messages after this line (incremental mode)
//   before: JSONL line number, only return messages before this line (history mode)
//   offset: legacy pagination offset (compatible, mutually exclusive with after/before)
router.get("/:id/transcript", async (req, res) => {
  const session = stmts.getSession.get(req.params.id);
  if (!session) {
    return res.status(404).json({ error: { code: "NOT_FOUND", message: "Session not found" } });
  }

  const agentId = req.query.agent_id || null;
  const limit = Math.min(parseInt(req.query.limit) || 50, 200);
  const afterLine = req.query.after ? parseInt(req.query.after) : null;
  const beforeLine = req.query.before ? parseInt(req.query.before) : null;
  const offset = parseInt(req.query.offset) || 0;

  // Determine the JSONL file path to read
  let jsonlPath;
  if (agentId && agentId !== "main") {
    jsonlPath =
      getSubagentTranscriptPath(req.params.id, session.cwd, agentId) ||
      findSubagentTranscriptPath(req.params.id, agentId);
  } else {
    jsonlPath =
      getTranscriptPath(req.params.id, session.cwd) || findTranscriptPath(req.params.id);
  }

  if (!jsonlPath || !fs.existsSync(jsonlPath)) {
    return res.json({ messages: [], total: 0, has_more: false, last_line: 0 });
  }

  try {
    // First pass: collect line numbers and parsed results for all valid messages
    const allMessages = [];
    let lineNum = 0;

    const rl = readline.createInterface({
      input: fs.createReadStream(jsonlPath, { encoding: "utf8" }),
      crlfDelay: Infinity,
    });

    for await (const line of rl) {
      lineNum++;
      if (!line.trim()) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== "user" && entry.type !== "assistant") continue;

      const msg = entry.type === "assistant" ? entry.message || {} : {};
      const content = [];

      if (entry.type === "user") {
        const msgContent = entry.message?.content;
        if (typeof msgContent === "string") {
          content.push({ type: "text", text: truncate(msgContent, 10240) });
        } else if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === "text" && block.text) {
              content.push({ type: "text", text: truncate(block.text, 10240) });
            } else if (block.type === "tool_result") {
              content.push({
                type: "tool_result",
                id: block.tool_use_id || null,
                output: truncate(
                  typeof block.content === "string"
                    ? block.content
                    : JSON.stringify(block.content || ""),
                  10240
                ),
                is_error: !!block.is_error,
              });
            }
          }
        } else if (msgContent === undefined || msgContent === null) {
          continue;
        }
      } else {
        const msgContent = msg.content || [];
        if (Array.isArray(msgContent)) {
          for (const block of msgContent) {
            if (block.type === "text" && block.text) {
              content.push({ type: "text", text: truncate(block.text, 10240) });
            } else if (block.type === "thinking" && block.thinking) {
              content.push({ type: "thinking", text: truncate(block.thinking, 10240) });
            } else if (block.type === "tool_use") {
              content.push({
                type: "tool_use",
                name: block.name || "unknown",
                id: block.id || null,
                input: truncateObj(block.input, 10240),
              });
            }
          }
        }
      }

      if (content.length === 0) continue;

      const message = {
        type: entry.type,
        timestamp: entry.timestamp
          ? typeof entry.timestamp === "number"
            ? new Date(entry.timestamp).toISOString()
            : entry.timestamp
          : null,
        content,
        line: lineNum,
      };

      if (entry.type === "assistant") {
        if (msg.model) message.model = msg.model;
        if (msg.usage) {
          message.usage = {
            input_tokens: msg.usage.input_tokens || 0,
            output_tokens: msg.usage.output_tokens || 0,
          };
        }
      }

      allMessages.push(message);
    }

    const total = allMessages.length;
    let messages;
    let hasMore = false;
    let lastLine = 0;

    if (afterLine !== null) {
      // Incremental mode: return messages with line > afterLine
      const startIdx = allMessages.findIndex((m) => m.line > afterLine);
      if (startIdx === -1) {
        messages = [];
        hasMore = false;
      } else {
        messages = allMessages.slice(startIdx, startIdx + limit);
        hasMore = startIdx + limit < total;
      }
    } else if (beforeLine !== null) {
      // History mode: return the latest N messages with line < beforeLine
      const endIdx = allMessages.findIndex((m) => m.line >= beforeLine);
      const sliceEnd = endIdx === -1 ? total : endIdx;
      const sliceStart = Math.max(0, sliceEnd - limit);
      messages = allMessages.slice(sliceStart, sliceEnd);
      hasMore = sliceStart > 0;
    } else if (offset > 0) {
      // Legacy offset pagination (compatible)
      messages = allMessages.slice(offset, offset + limit);
      hasMore = offset + limit < total;
    } else {
      // Default: return the latest N messages (chat-flow mode)
      const sliceStart = Math.max(0, total - limit);
      messages = allMessages.slice(sliceStart);
      hasMore = sliceStart > 0;
    }

    if (messages.length > 0) {
      lastLine = messages[messages.length - 1].line;
    }

    const firstLine = messages.length > 0 ? messages[0].line : 0;

    // Remove internal line field from messages
    for (const m of messages) {
      delete m.line;
    }

    res.json({
      messages,
      total,
      has_more: hasMore,
      last_line: lastLine,
      first_line: firstLine,
    });
  } catch (err) {
    res.json({ messages: [], total: 0, has_more: false, last_line: 0 });
  }
});

function truncate(str, maxLen) {
  if (!str || str.length <= maxLen) return str;
  return str.slice(0, maxLen) + "[truncated]";
}

function truncateObj(obj, maxLen) {
  if (!obj) return obj;
  const json = JSON.stringify(obj);
  if (json.length <= maxLen) return obj;
  return { _truncated: truncate(json, maxLen) };
}

module.exports = router;
