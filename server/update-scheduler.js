/**
 * @file Periodic git upstream check and WebSocket broadcast when update availability changes.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { getUpdatesStatus } = require("./lib/update-check");

function isUpdateCheckDisabled() {
  const v = process.env.DASHBOARD_UPDATE_CHECK;
  return v === "0" || v === "false" || v === "off";
}

function intervalMs() {
  const n = Number.parseInt(process.env.DASHBOARD_UPDATE_CHECK_INTERVAL_MS || "", 10);
  if (Number.isFinite(n) && n >= 60_000) return n;
  return 5 * 60 * 1000;
}

function startUpdateScheduler({ broadcast }) {
  if (isUpdateCheckDisabled()) return { stop: () => {} };

  let lastFingerprint = "";
  let lastHadUpdate = false;
  let stopped = false;
  let initialTimer = null;
  let intervalTimer = null;

  async function tick() {
    if (stopped) return;
    try {
      const status = await getUpdatesStatus();
      const fp = JSON.stringify({
        a: Boolean(status.update_available),
        r: status.remote_sha || null,
        b: status.commits_behind || 0,
        e: status.fetch_error || null,
      });
      const changed = fp !== lastFingerprint;
      lastFingerprint = fp;
      if (changed) {
        broadcast("update_status", status);
      }
      const becameAvailable = status.update_available && !lastHadUpdate;
      lastHadUpdate = Boolean(status.update_available);
      if (becameAvailable) {
        const line = "━".repeat(52);
        console.log(`\n${line}`);
        console.log("  Agent Dashboard: upstream update available");
        console.log(`  ${status.message || ""}`);
        if (status.manual_command) {
          console.log(`  Run: ${status.manual_command}`);
          console.log("  Then restart the dashboard the same way you started it.");
        }
        console.log(`${line}\n`);
      }
    } catch {
      // Non-fatal — never block the server on update checks
    }
  }

  initialTimer = setTimeout(() => {
    tick();
  }, 8_000);
  if (typeof initialTimer.unref === "function") initialTimer.unref();

  intervalTimer = setInterval(tick, intervalMs());
  if (typeof intervalTimer.unref === "function") intervalTimer.unref();

  return {
    stop: () => {
      stopped = true;
      if (initialTimer) clearTimeout(initialTimer);
      if (intervalTimer) clearInterval(intervalTimer);
    },
  };
}

module.exports = { startUpdateScheduler };
