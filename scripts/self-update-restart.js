#!/usr/bin/env node
/**
 * @file After the dashboard exits, waits briefly, fast-forwards the git checkout, runs npm run setup, then starts the server again.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { spawnSync, spawn } = require("child_process");
const path = require("path");

const root = path.resolve(__dirname, "..");

function sleepSeconds(seconds) {
  if (process.platform === "win32") {
    spawnSync("powershell", ["-NoProfile", "-Command", `Start-Sleep -Seconds ${seconds}`], {
      stdio: "ignore",
    });
  } else {
    spawnSync("sleep", [String(seconds)], { stdio: "ignore" });
  }
}

sleepSeconds(2);

function run(cmd, args, extra = {}) {
  const r = spawnSync(cmd, args, {
    cwd: root,
    stdio: "inherit",
    shell: extra.shell === true,
  });
  if (r.error) {
    console.error(r.error);
    process.exit(1);
  }
  if (r.status !== 0) process.exit(r.status || 1);
}

run("git", ["pull", "--ff-only"], {});
run("npm", ["run", "setup"], { shell: true });

if (process.env.NODE_ENV === "production") {
  run("npm", ["run", "build"], { shell: true });
}

const startCmd = (process.env.DASHBOARD_RESTART_COMMAND || "npm start").trim();
spawn(startCmd, [], { cwd: root, detached: true, stdio: "ignore", shell: true }).unref();
