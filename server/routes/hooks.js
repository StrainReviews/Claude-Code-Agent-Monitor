/**
 * @file Express router for handling incoming hook events from Claude CLI. It processes various hook types (PreToolUse, PostToolUse, Stop, SubagentStop, SessionStart, SessionEnd, Notification), updates session and agent states accordingly in the database, extracts token usage from transcripts, detects compaction events, and broadcasts updates to connected clients via WebSocket.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { Router } = require("express");
const { v4: uuidv4 } = require("uuid");
const fs = require("fs");
const path = require("path");
const dbModule = require("../db");
const { stmts, db } = dbModule;
const { broadcast } = require("../websocket");
const TranscriptCache = require("../lib/transcript-cache");
const { scanAndImportSubagents } = require("../../scripts/import-history");

const router = Router();

// Shared cache instance — reused by periodic compaction scanner via router.transcriptCache
const transcriptCache = new TranscriptCache();

const _backfillThrottle = new Set();

// Scan the nested subagents/ directory next to the main transcript and fill
// in model + token usage for any subagent row that is still "working" and
// has no model yet.
function backfillWorkingSubagents(sessionId, mainTranscriptPath) {
  if (!mainTranscriptPath) return;
  const subDir = mainTranscriptPath.replace(/\.jsonl$/i, "") + path.sep + "subagents";
  let files;
  try {
    files = fs.readdirSync(subDir);
  } catch {
    return;
  }

  const working = db
    .prepare(
      "SELECT * FROM agents WHERE session_id = ? AND type = 'subagent' AND model IS NULL AND status != 'error'"
    )
    .all(sessionId);
  if (working.length === 0) return;

  const index = [];
  for (const f of files) {
    if (!f.endsWith(".meta.json")) continue;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(subDir, f), "utf8"));
      if (!meta.description) continue;
      const jsonl = path.join(subDir, f.replace(/\.meta\.json$/, ".jsonl"));
      index.push({ description: meta.description, jsonl });
    } catch {
      // ignore unreadable meta
    }
  }
  if (index.length === 0) return;

  for (const sub of working) {
    const bare = sub.name.endsWith("...") ? sub.name.slice(0, -3) : sub.name;
    const match =
      index.find((e) => sub.name.startsWith(e.description.slice(0, 57))) ||
      index.find((e) => e.description === bare);
    if (!match) continue;

    const summary = transcriptCache.extractSubagentSummary(match.jsonl);
    if (!summary) continue;

    stmts.updateAgentModel.run(summary.primaryModel, sub.id);
    for (const [model, tokens] of Object.entries(summary.tokensByModel)) {
      stmts.replaceSubagentTokens.run(
        sub.id,
        sessionId,
        model,
        tokens.input,
        tokens.output,
        tokens.cacheRead,
        tokens.cacheWrite
      );
    }
    broadcast("agent_updated", stmts.getAgent.get(sub.id));
  }
}

const STALE_MINUTES = (() => {
  const raw = parseInt(process.env.DASHBOARD_STALE_MINUTES, 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 180;
})();

const WAITING_INPUT_PATTERN =
  /\bpermission\b|waiting (?:for )?(?:your )?(?:input|response|reply|approval)|needs?\s+your\s+(?:input|approval|response|attention)|approval\s+(?:needed|required)|awaiting\s+(?:your\s+)?(?:input|approval|response)/i;

function isWaitingForUserMessage(msg) {
  if (!msg || typeof msg !== "string") return false;
  return WAITING_INPUT_PATTERN.test(msg);
}

function clearAwaitingInput(sessionId, mainAgentId, broadcastUpdates, pendingBroadcasts) {
  const cleared = stmts.clearSessionAgentsAwaitingInput.run(sessionId);
  const sessCleared = stmts.clearSessionAwaitingInput.run(sessionId);
  if (broadcastUpdates && cleared.changes > 0 && mainAgentId) {
    const refreshedMain = stmts.getAgent.get(mainAgentId);
    if (refreshedMain) pendingBroadcasts.push(["agent_updated", refreshedMain]);
  }
  if (broadcastUpdates && sessCleared.changes > 0) {
    const refreshedSess = stmts.getSession.get(sessionId);
    if (refreshedSess) pendingBroadcasts.push(["session_updated", refreshedSess]);
  }
}

function ensureSession(sessionId, data, pendingBroadcasts) {
  let session = stmts.getSession.get(sessionId);
  if (!session) {
    stmts.insertSession.run(
      sessionId,
      data.session_name || `Session ${sessionId.slice(0, 8)}`,
      "active",
      data.cwd || null,
      data.model || null,
      null
    );
    session = stmts.getSession.get(sessionId);
    pendingBroadcasts.push(["session_created", session]);

    // Create main agent for new session
    const mainAgentId = `${sessionId}-main`;
    const sessionLabel = session.name || `Session ${sessionId.slice(0, 8)}`;
    stmts.insertAgent.run(
      mainAgentId,
      sessionId,
      `Main Agent — ${sessionLabel}`,
      "main",
      null,
      "connected",
      null,
      null,
      null
    );
    pendingBroadcasts.push(["agent_created", stmts.getAgent.get(mainAgentId)]);
  }
  return session;
}

function getMainAgent(sessionId) {
  return stmts.getAgent.get(`${sessionId}-main`);
}

const processEvent = (hookType, data) => {
  const sessionId = data.session_id;
  if (!sessionId) return null;

  // ── Phase 1: Disk I/O and preparation OUTSIDE any transaction ──
  // Extract transcript data (heavy disk I/O — reads JSONL files from disk).
  // This is the main bottleneck that was holding the EXCLUSIVE lock for >100ms.
  let transcriptResult = null;
  if (data.transcript_path) {
    transcriptResult = transcriptCache.extract(data.transcript_path);
  }

  // Extract subagent summary (disk I/O) for SubagentStop events.
  let subagentSummaryResult = null;
  if (hookType === "SubagentStop" && data.agent_transcript_path) {
    subagentSummaryResult = transcriptCache.extractSubagentSummary(data.agent_transcript_path);
  }

  // ── Phase 2: Dedup queries OUTSIDE the transaction ──
  // A short race-condition window is acceptable — duplicates are caught
  // by the dedup index and result in a harmless INSERT failure at worst.

  // Pre-check which compaction entries already exist
  const existingCompactIds = new Set();
  if (transcriptResult && transcriptResult.compaction) {
    for (const entry of transcriptResult.compaction.entries) {
      const compactId = `${sessionId}-compact-${entry.uuid}`;
      if (stmts.getAgent.get(compactId)) {
        existingCompactIds.add(compactId);
      }
    }
  }

  // Pre-check which API errors already exist
  const existingApiErrors = new Set();
  if (transcriptResult && transcriptResult.errors) {
    for (const apiErr of transcriptResult.errors) {
      const existing = db
        .prepare(
          `SELECT 1 FROM events WHERE session_id = ? AND event_type = 'APIError'
           AND summary = ? LIMIT 1`
        )
        .get(sessionId, `${apiErr.type}: ${apiErr.message}`);
      if (existing) {
        existingApiErrors.add(`${apiErr.type}: ${apiErr.message}`);
      }
    }
  }

  // Pre-check which turn duration events already exist
  const existingTurnDurations = new Set();
  if (transcriptResult && transcriptResult.turnDurations) {
    for (const td of transcriptResult.turnDurations) {
      const tdTs = td.timestamp || new Date().toISOString();
      const existing = db
        .prepare(
          "SELECT 1 FROM events WHERE session_id = ? AND event_type = 'TurnDuration' AND created_at = ? LIMIT 1"
        )
        .get(sessionId, tdTs);
      if (existing) {
        existingTurnDurations.add(tdTs);
      }
    }
  }

  // ── Phase 3: Short write transaction for all DB mutations ──
  // All broadcast() calls are deferred to Phase 4 to keep the EXCLUSIVE
  // lock duration minimal (<5ms). Reads that must follow a write (e.g.
  // getAgent after updateAgent) still happen inside to guarantee consistency,
  // but their results are stashed in pendingBroadcasts for later emission.
  const pendingBroadcasts = [];
  let shouldScheduleBackfill = false;

  const result = db.transaction(() => {
  const session = ensureSession(sessionId, data, pendingBroadcasts);
  let mainAgent = getMainAgent(sessionId);
  const mainAgentId = mainAgent?.id ?? null;

  // Reactivate non-active sessions when we receive hook events proving the session is alive.
  // - Work events (PreToolUse, PostToolUse, Notification, SessionStart) always reactivate.
  // - Stop/SubagentStop reactivate only if session is completed/abandoned — this handles
  //   sessions imported as "completed" before the server started, where the first hook event
  //   might be a Stop. For error sessions, Stop should NOT reactivate (the error is intentional).
  // - SessionEnd never reactivates.
  const isNonTerminalEvent = hookType !== "SessionEnd";
  const isStopLike = hookType === "Stop" || hookType === "SubagentStop";
  const isImportedOrAbandoned = session.status === "completed" || session.status === "abandoned";
  const needsReactivation =
    session.status !== "active" && isNonTerminalEvent && (!isStopLike || isImportedOrAbandoned);
  if (needsReactivation) {
    stmts.reactivateSession.run(sessionId);
    pendingBroadcasts.push(["session_updated", stmts.getSession.get(sessionId)]);

    if (mainAgent && mainAgent.status !== "working" && mainAgent.status !== "connected") {
      stmts.reactivateAgent.run(mainAgentId);
      mainAgent = stmts.getAgent.get(mainAgentId);
      pendingBroadcasts.push(["agent_updated", mainAgent]);
    }
  }

  let eventType = hookType;
  let toolName = data.tool_name || null;
  let summary = null;
  let agentId = mainAgentId;

  // NOTE: clearing of awaiting_input_since is handled per-case below rather
  // than blanket-clearing on every non-Notification event. The blanket rule
  // caused spontaneous waiting → active flips when *any* hook arrived after
  // a Stop — most commonly SubagentStop for backgrounded subagents, but
  // also occasionally a late PostToolUse from a background tool. A subagent
  // or background tool finishing tells us nothing about whether the human
  // has actually responded, so those events must NOT clear the flag.

  switch (hookType) {
    case "PreToolUse": {
      summary = `Using tool: ${toolName}`;

      // PreToolUse means Claude is actively running a tool, ergo the user
      // has resumed (Stop only fires at end of turn — Claude can't start a
      // new tool call without fresh user input). Clear waiting now.
      clearAwaitingInput(sessionId, mainAgentId, true, pendingBroadcasts);

      // If the tool is Agent, a subagent is being created
      if (toolName === "Agent") {
        const input = data.tool_input || {};
        const subId = uuidv4();
        // Use description, then type, then first line of prompt, then fallback
        const rawName =
          input.description ||
          input.subagent_type ||
          (input.prompt ? input.prompt.split("\n")[0].slice(0, 60) : null) ||
          "Subagent";
        const subName = rawName.length > 60 ? rawName.slice(0, 57) + "..." : rawName;

        // Infer which agent is spawning this subagent.
        // Hook events don't carry an explicit agent ID, so we use a heuristic:
        //   - If the main agent is actively working, it's the one spawning (common case).
        //   - If the main agent is idle/connected (waiting for user or subagent results),
        //     the spawn must come from an already-running subagent — pick the deepest
        //     working subagent (most recently nested active agent).
        //   - Fallback to main if nothing else matches.
        let parentId = mainAgentId;
        if (mainAgent && mainAgent.status !== "working") {
          const deepest = stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
          if (deepest) {
            parentId = deepest.id;
          }
        }

        stmts.insertAgent.run(
          subId,
          sessionId,
          subName,
          "subagent",
          input.subagent_type || null,
          "working",
          input.prompt ? input.prompt.slice(0, 500) : null,
          parentId,
          input.metadata ? JSON.stringify(input.metadata) : null
        );
        pendingBroadcasts.push(["agent_created", stmts.getAgent.get(subId)]);
        agentId = subId;
        summary = `Subagent spawned: ${subName}`;
      }

      // Update main agent status to "working" — but only when main is the likely
      // actor. When main is idle and working subagents exist, PreToolUse events
      // come from subagents, not main. Incorrectly promoting main to "working"
      // would break parent inference for nested agent spawning.
      //
      // Heuristic: main is idle + working subagents exist → subagent is the actor.
      //            main is connected/working/idle with no subagents → main is the actor.
      const subagentIsActor =
        mainAgent &&
        mainAgent.status === "idle" &&
        !!stmts.findDeepestWorkingAgent.get(sessionId, sessionId);
      if (
        mainAgent &&
        !subagentIsActor &&
        (mainAgent.status === "working" ||
          mainAgent.status === "connected" ||
          mainAgent.status === "idle")
      ) {
        stmts.updateAgent.run(null, "working", null, toolName, null, null, mainAgentId);
        pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(mainAgentId)]);
      }
      break;
    }

    case "PostToolUse": {
      summary = `Tool completed: ${toolName}`;

      // Clear waiting too. The non-obvious case this covers: a permission
      // Notification fires *between* PreToolUse and PostToolUse (when Claude
      // Code prompts the user mid-tool). The Notification stamps waiting,
      // the user approves, the tool completes, PostToolUse arrives. Without
      // a clear here, we'd be stuck in waiting until the next PreToolUse.
      clearAwaitingInput(sessionId, mainAgentId, true, pendingBroadcasts);

      // NOTE: PostToolUse for "Agent" tool fires immediately when a subagent is
      // backgrounded — it does NOT mean the subagent finished its work.
      // Subagent completion is handled by SubagentStop, not here.

      // Only clear current_tool on the main agent if it's actively working.
      // Skip if idle (waiting for subagents) or already completed.
      if (mainAgent && mainAgent.status === "working") {
        stmts.updateAgent.run(null, null, null, null, null, null, mainAgentId);
        pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(mainAgentId)]);
      }
      break;
    }

    case "Stop": {
      const session = stmts.getSession.get(sessionId);
      const sessionLabel = session?.name || `Session ${sessionId.slice(0, 8)}`;
      summary =
        data.stop_reason === "error"
          ? `Error in ${sessionLabel}`
          : `${sessionLabel} — ready for input`;

      // Stop means Claude finished its turn, NOT that the session is closed.
      // Session stays active — user can still send more messages.
      // Background subagents may still be running — do NOT complete them
      // here. They complete via SubagentStop, or all at once on SessionEnd.
      //
      // CRITICAL: do all DB writes BEFORE any broadcast, then broadcast the
      // final state once. An earlier version broadcast agent_updated twice
      // (first with status=idle and no flag, then again after the flag was
      // set) which made the agent flicker out of every Kanban column for a
      // tick — visible to users as "agent skipped waiting and went to
      // completed", because the Idle column no longer exists and Waiting
      // requires the flag.
      const now = new Date().toISOString();
      const agentMutable =
        !!mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error";

      if (data.stop_reason === "error") {
        if (agentMutable) {
          stmts.updateAgent.run(null, "idle", null, null, null, null, mainAgentId);
        }
        stmts.updateSession.run(null, "error", now, null, sessionId);
        // Error stop is terminal-ish — drop any waiting flag so the row
        // lands cleanly in the Error column.
        clearAwaitingInput(sessionId, mainAgentId, false, pendingBroadcasts);
      } else {
        if (agentMutable) {
          stmts.updateAgent.run(null, "idle", null, null, null, null, mainAgentId);
        }
        // Stamp the waiting flag in the same DB pass as the idle update so
        // the post-write read returns a consistent (idle, awaiting=set)
        // row. Effective status flips working → waiting in one broadcast.
        stmts.setSessionAwaitingInput.run(now, sessionId);
        if (mainAgentId) stmts.setAgentAwaitingInput.run(now, mainAgentId);
      }

      // Read final state for broadcast — still inside transaction for
      // consistency, but the broadcast itself is deferred to Phase 4.
      pendingBroadcasts.push(["session_updated", stmts.getSession.get(sessionId)]);
      if (mainAgentId) {
        pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(mainAgentId)]);
      }
      break;
    }

    case "SubagentStop": {
      summary = `Subagent completed`;
      const subagents = stmts.listAgentsBySession.all(sessionId);
      let matchingSub = null;

      // Try to identify which subagent stopped using available data.
      // SubagentStop provides: agent_type (e.g. "Explore", "test-engineer"),
      // agent_id (Claude's internal ID), description, last_assistant_message.
      const subDesc = data.description || data.agent_type || data.subagent_type || null;
      if (subDesc) {
        const namePrefix = subDesc.length > 57 ? subDesc.slice(0, 57) : subDesc;
        matchingSub = subagents.find(
          (a) => a.type === "subagent" && a.status === "working" && a.name.startsWith(namePrefix)
        );
      }

      // Try matching by agent_type against stored subagent_type
      if (!matchingSub && data.agent_type) {
        matchingSub = subagents.find(
          (a) =>
            a.type === "subagent" && a.status === "working" && a.subagent_type === data.agent_type
        );
      }

      if (!matchingSub) {
        const prompt = data.prompt ? data.prompt.slice(0, 500) : null;
        if (prompt) {
          matchingSub = subagents.find(
            (a) => a.type === "subagent" && a.status === "working" && a.task === prompt
          );
        }
      }

      // Fallback: oldest working subagent
      if (!matchingSub) {
        matchingSub = subagents.find((a) => a.type === "subagent" && a.status === "working");
      }

      if (matchingSub) {
        stmts.updateAgent.run(
          null,
          "completed",
          null,
          null,
          new Date().toISOString(),
          null,
          matchingSub.id
        );

        // Apply pre-extracted subagent summary (disk I/O happened in Phase 1).
        // The main session transcript (transcript_path) only contains
        // main-agent messages — subagent API calls live in a separate JSONL
        // under subagents/. Without this read the dashboard would continue to
        // show every subagent as running on the main session's model.
        //
        // Main-session token_usage and subagent_token_usage are disjoint
        // record sets (different source files, different API calls on
        // Anthropic's side) so additive summation in getTokensBySession is
        // correct — no subtraction needed to "pull Haiku out of Opus".
        if (subagentSummaryResult) {
          stmts.updateAgentModel.run(subagentSummaryResult.primaryModel, matchingSub.id);
          for (const [model, tokens] of Object.entries(subagentSummaryResult.tokensByModel)) {
            stmts.replaceSubagentTokens.run(
              matchingSub.id,
              sessionId,
              model,
              tokens.input,
              tokens.output,
              tokens.cacheRead,
              tokens.cacheWrite
            );
          }
        }

        pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(matchingSub.id)]);
        agentId = matchingSub.id;
        summary = `Subagent completed: ${matchingSub.name}`;

        // Session stays active — SubagentStop just means one subagent finished,
        // the session is not over until the user explicitly closes it.
      }
      break;
    }

    case "SessionStart": {
      summary = data.source === "resume" ? "Session resumed" : "Session started";

      // Reactivation is already handled above for non-active sessions.
      // Promote main agent from idle → connected if needed.
      if (mainAgent && mainAgent.status === "idle") {
        stmts.updateAgent.run(null, "connected", null, null, null, null, mainAgentId);
      }

      // A just-started or just-resumed session is sitting at a prompt
      // waiting for the user's first message — Claude Code hasn't done
      // anything yet. Stamp awaiting_input_since so it lands in Waiting
      // from the moment the dashboard sees it. UserPromptSubmit (when the
      // user hits enter) or PreToolUse (when Claude actually runs a tool)
      // will clear the flag.
      const sessionStartTs = new Date().toISOString();
      stmts.setSessionAwaitingInput.run(sessionStartTs, sessionId);
      if (mainAgentId) stmts.setAgentAwaitingInput.run(sessionStartTs, mainAgentId);

      // Read final state for broadcast — still inside transaction for
      // consistency, but the broadcast itself is deferred to Phase 4.
      pendingBroadcasts.push(["session_updated", stmts.getSession.get(sessionId)]);
      if (mainAgentId) pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(mainAgentId)]);

      // Clean up orphaned sessions: when a user runs /resume inside a session,
      // the parent session never receives Stop or SessionEnd. Mark any active
      // session that hasn't seen events for STALE_MINUTES as abandoned.
      const staleSessions = stmts.findStaleSessions.all(sessionId, STALE_MINUTES);
      const now = new Date().toISOString();
      for (const stale of staleSessions) {
        const staleAgents = stmts.listAgentsBySession.all(stale.id);
        for (const agent of staleAgents) {
          if (agent.status !== "completed" && agent.status !== "error") {
            stmts.updateAgent.run(null, "completed", null, null, now, null, agent.id);
            pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(agent.id)]);
          }
        }
        stmts.updateSession.run(null, "abandoned", now, null, stale.id);
        pendingBroadcasts.push(["session_updated", stmts.getSession.get(stale.id)]);
      }
      break;
    }

    case "SessionEnd": {
      const endSession = stmts.getSession.get(sessionId);
      const endLabel = endSession?.name || `Session ${sessionId.slice(0, 8)}`;
      summary = `Session closed: ${endLabel}`;

      // Session is terminating — drop any waiting flag so the row lands in
      // the Completed column without a leftover yellow overlay.
      clearAwaitingInput(sessionId, mainAgentId, false, pendingBroadcasts);

      // SessionEnd is the definitive signal that the CLI process exited.
      // Mark everything as completed.
      const allAgents = stmts.listAgentsBySession.all(sessionId);
      const now = new Date().toISOString();
      for (const agent of allAgents) {
        if (agent.status !== "completed" && agent.status !== "error") {
          stmts.updateAgent.run(null, "completed", null, null, now, null, agent.id);
          pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(agent.id)]);
        }
      }
      stmts.updateSession.run(null, "completed", now, null, sessionId);
      pendingBroadcasts.push(["session_updated", stmts.getSession.get(sessionId)]);

      break;
    }

    case "UserPromptSubmit": {
      // User just hit enter on a new prompt. This is the unambiguous
      // "session resumed" signal — fires before Claude does anything,
      // unlike PreToolUse which only fires for tool-using turns. Clear
      // the Waiting flag and promote the main agent to Working so the
      // dashboard reflects "Claude is now thinking on this" through the
      // entire response, including text-only replies that emit no
      // PreToolUse before Stop.
      summary = "User prompt submitted";
      clearAwaitingInput(sessionId, mainAgentId, true, pendingBroadcasts);
      if (mainAgent && mainAgent.status !== "completed" && mainAgent.status !== "error") {
        stmts.updateAgent.run(null, "working", null, null, null, null, mainAgentId);
        pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(mainAgentId)]);
      }
      break;
    }

    case "Notification": {
      const msg = data.message || "Notification received";
      // Tag compaction-related notifications so they show as Compaction events
      if (/compact|compress|context.*(reduc|truncat|summar)/i.test(msg)) {
        eventType = "Compaction";
        summary = msg;
      } else if (isWaitingForUserMessage(msg)) {
        // Claude Code is blocked waiting for the user (permission prompt or
        // explicit "waiting for input" notice). Stamp session + main agent
        // so the dashboard can surface a yellow "Waiting" badge until the
        // user responds — at which point the next PreToolUse/Stop clears it.
        const ts = new Date().toISOString();
        stmts.setSessionAwaitingInput.run(ts, sessionId);
        pendingBroadcasts.push(["session_updated", stmts.getSession.get(sessionId)]);
        if (mainAgentId) {
          stmts.setAgentAwaitingInput.run(ts, mainAgentId);
          pendingBroadcasts.push(["agent_updated", stmts.getAgent.get(mainAgentId)]);
        }
        summary = msg;
      } else {
        summary = msg;
      }
      break;
    }

    default: {
      summary = `Event: ${hookType}`;
    }
  }

  // Apply pre-extracted transcript data (disk I/O happened in Phase 1).
  // Only DB writes remain here — the heavy JSONL parsing is already done.
  if (transcriptResult) {
      const { tokensByModel, compaction } = transcriptResult;

      // Register compaction agents and events.
      // Each isCompactSummary entry in the JSONL = one compaction that occurred.
      // Deduplicate using pre-checked existingCompactIds set (Phase 2).
      if (compaction) {
        for (const entry of compaction.entries) {
          const compactId = `${sessionId}-compact-${entry.uuid}`;
          if (existingCompactIds.has(compactId)) continue;

          const ts = entry.timestamp || new Date().toISOString();
          stmts.insertAgent.run(
            compactId,
            sessionId,
            "Context Compaction",
            "subagent",
            "compaction",
            "completed",
            "Automatic conversation context compression",
            mainAgentId,
            null
          );
          stmts.updateAgent.run(null, "completed", null, null, ts, null, compactId);
          pendingBroadcasts.push(["agent_created", stmts.getAgent.get(compactId)]);

          const compactSummary = `Context compacted — conversation history compressed (#${compaction.entries.indexOf(entry) + 1})`;
          stmts.insertEvent.run(
            sessionId,
            compactId,
            "Compaction",
            null,
            compactSummary,
            JSON.stringify({
              uuid: entry.uuid,
              timestamp: ts,
              compaction_number: compaction.entries.indexOf(entry) + 1,
              total_compactions: compaction.count,
            })
          );
          pendingBroadcasts.push(["new_event", {
            session_id: sessionId,
            agent_id: compactId,
            event_type: "Compaction",
            tool_name: null,
            summary: compactSummary,
            created_at: ts,
          }]);
        }
      }

      if (tokensByModel) {
        for (const [model, tokens] of Object.entries(tokensByModel)) {
          stmts.replaceTokenUsage.run(
            sessionId,
            model,
            tokens.input,
            tokens.output,
            tokens.cacheRead,
            tokens.cacheWrite
          );
        }

        // Mirror the session's primary model onto the main agent so the
        // dashboard can render a model badge next to it (same way subagents
        // get theirs from agent_transcript_path on SubagentStop).
        const mainModelEntries = Object.entries(tokensByModel);
        if (mainModelEntries.length > 0 && mainAgentId) {
          const [primaryMain] = mainModelEntries.reduce((best, cur) =>
            cur[1].output > best[1].output ? cur : best
          );
          const currentMain = stmts.getAgent.get(mainAgentId);
          if (currentMain && currentMain.model !== primaryMain) {
            stmts.updateAgentModel.run(primaryMain, mainAgentId);
          }
        }
      }

      // Flag backfill for scheduling AFTER the transaction releases the lock.
      if (data.transcript_path && !_backfillThrottle.has(sessionId)) {
        shouldScheduleBackfill = true;
      }

      // Register API errors from transcript (quota limits, rate limits, overloaded, etc.)
      // Dedup using pre-checked existingApiErrors set (Phase 2).
      if (transcriptResult.errors) {
        for (const apiErr of transcriptResult.errors) {
          const errSummary = `${apiErr.type}: ${apiErr.message}`;
          if (existingApiErrors.has(errSummary)) continue;

          stmts.insertEvent.run(
            sessionId,
            mainAgentId,
            "APIError",
            null,
            errSummary,
            JSON.stringify(apiErr)
          );
          pendingBroadcasts.push(["new_event", {
            session_id: sessionId,
            agent_id: mainAgentId,
            event_type: "APIError",
            tool_name: null,
            summary: errSummary,
            created_at: apiErr.timestamp || new Date().toISOString(),
          }]);
        }
      }

      // Register turn duration events from transcript.
      // Dedup using pre-checked existingTurnDurations set (Phase 2).
      if (transcriptResult.turnDurations) {
        for (const td of transcriptResult.turnDurations) {
          const tdTs = td.timestamp || new Date().toISOString();
          if (existingTurnDurations.has(tdTs)) continue;

          const tdSummary = `Turn completed in ${(td.durationMs / 1000).toFixed(1)}s`;
          stmts.insertEvent.run(
            sessionId,
            mainAgentId,
            "TurnDuration",
            null,
            tdSummary,
            JSON.stringify({ durationMs: td.durationMs })
          );
          pendingBroadcasts.push(["new_event", {
            session_id: sessionId,
            agent_id: mainAgentId,
            event_type: "TurnDuration",
            tool_name: null,
            summary: tdSummary,
            created_at: tdTs,
          }]);
        }
      }

      // Update session metadata with enriched data (thinking blocks, usage extras)
      if (transcriptResult.usageExtras || transcriptResult.thinkingBlockCount > 0) {
        const session = stmts.getSession.get(sessionId);
        if (session) {
          const meta = session.metadata ? JSON.parse(session.metadata) : {};
          if (transcriptResult.usageExtras) {
            meta.usage_extras = transcriptResult.usageExtras;
          }
          if (transcriptResult.thinkingBlockCount > 0) {
            meta.thinking_blocks = (meta.thinking_blocks || 0) + transcriptResult.thinkingBlockCount;
          }
          if (transcriptResult.turnDurations) {
            meta.turn_count = (meta.turn_count || 0) + transcriptResult.turnDurations.length;
            const totalMs = transcriptResult.turnDurations.reduce((s, t) => s + t.durationMs, 0);
            meta.total_turn_duration_ms = (meta.total_turn_duration_ms || 0) + totalMs;
          }
          stmts.updateSession.run(null, null, null, JSON.stringify(meta), sessionId);
        }
      }
  }

  // Bump session updated_at on every event
  stmts.touchSession.run(sessionId);

  stmts.insertEvent.run(
    sessionId,
    agentId,
    eventType,
    toolName,
    summary,
    JSON.stringify(data)
    // created_at uses default
  );

  return {
    session_id: sessionId,
    agent_id: agentId,
    event_type: eventType,
    tool_name: toolName,
    summary,
    created_at: new Date().toISOString(),
  };
  })();

  // ── Phase 4: Post-transaction broadcasts and cleanup (no lock held) ──
  // Drain all deferred broadcasts now that the EXCLUSIVE lock is released.
  for (const [type, payload] of pendingBroadcasts) {
    broadcast(type, payload);
  }
  broadcast("new_event", result);

  // Defer subagent model backfill — throttled to once per 30s per session
  // to avoid flooding the event loop with filesystem scans under high
  // hook traffic (400+ events/5min during active Claude sessions).
  // Scheduled outside the transaction so the EXCLUSIVE lock is not held
  // while the timer is registered, and the deferred callback itself does
  // not compete with an in-flight transaction.
  if (shouldScheduleBackfill) {
    _backfillThrottle.add(sessionId);
    setTimeout(() => {
      _backfillThrottle.delete(sessionId);
      try {
        backfillWorkingSubagents(sessionId, data.transcript_path);
      } catch {
        // SQLITE_BUSY — will retry on next throttle window
      }
    }, 30_000);
  }

  // Evict transcript from cache on SessionEnd — session is done, no more reads expected.
  // Must happen after token extraction above to avoid re-populating the cache.
  if (hookType === "SessionEnd" && data.transcript_path) {
    transcriptCache.invalidate(data.transcript_path);
  }

  return result;
};

router.post("/event", (req, res) => {
  const { hook_type, data } = req.body;
  if (!hook_type || !data) {
    return res.status(400).json({
      error: { code: "INVALID_INPUT", message: "hook_type and data are required" },
    });
  }

  const result = processEvent(hook_type, data);
  if (!result) {
    return res.status(400).json({
      error: { code: "MISSING_SESSION", message: "session_id is required in data" },
    });
  }

  res.json({ ok: true, event: result });

  // After SubagentStop, scan the session's subagent JSONL files and ingest any
  // tool calls that aren't yet in the events table. Subagent tool_use blocks
  // never fire hooks on the parent session — this scan is the only path that
  // attributes them to the subagent's agent_id.
  //
  // Delayed by 5 seconds to avoid colliding with the processEvent transaction
  // that likely follows immediately (the next hook event). Without this delay
  // the many unprotected DB writes inside scanAndImportSubagents would race
  // with the EXCLUSIVE lock held by processEvent, causing SQLITE_BUSY errors.
  if (hook_type === "SubagentStop" && data.session_id && data.transcript_path) {
    setTimeout(() => {
      scanAndImportSubagents(dbModule, data.session_id, data.transcript_path)
        .then(({ created }) => {
          if (created > 0) {
            // Nudge SessionDetail to refetch — the page already debounces
            // bursts of new_event into a single paginated reload.
            broadcast("new_event", {
              session_id: data.session_id,
              agent_id: null,
              event_type: "SubagentJsonlImported",
              tool_name: null,
              summary: `Imported ${created} subagent record(s) from JSONL`,
              created_at: new Date().toISOString(),
            });
          }
        })
        .catch(() => {
          // non-fatal — partial JSONL during a live run is expected
        });
    }, 5000);
  }
});

router.transcriptCache = transcriptCache;
module.exports = router;
