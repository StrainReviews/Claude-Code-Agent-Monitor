/**
 * @file Detects whether the dashboard git checkout is behind the default remote branch (e.g. origin/master) after a non-destructive fetch.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const fs = require("fs");
const path = require("path");
const { execFile } = require("child_process");

const DEFAULT_ROOT = path.join(__dirname, "..", "..");

function execGit(cwd, args, opts = {}) {
  const timeout = opts.timeout ?? 120_000;
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, timeout, maxBuffer: 2_000_000, encoding: "utf8" },
      (err, stdout) => {
        if (err) reject(err);
        else resolve(String(stdout).trim());
      }
    );
  });
}

async function resolveCompareRef(gitRoot) {
  const tryRefs = ["origin/master", "origin/main"];
  for (const ref of tryRefs) {
    try {
      await execGit(gitRoot, ["rev-parse", "--verify", ref], { timeout: 10_000 });
      return ref;
    } catch {
      // continue
    }
  }
  try {
    const sym = await execGit(gitRoot, ["symbolic-ref", "refs/remotes/origin/HEAD"], {
      timeout: 10_000,
    });
    const m = sym.match(/^refs\/remotes\/(.+)$/);
    if (m) return m[1];
  } catch {
    // ignore
  }
  return null;
}

async function hasOrigin(gitRoot) {
  try {
    const out = await execGit(gitRoot, ["remote"], { timeout: 10_000 });
    return out
      .split(/\r?\n/)
      .map((l) => l.trim())
      .includes("origin");
  } catch {
    return false;
  }
}

/**
 * @param {string} [gitRoot]
 * @param {{ skipFetch?: boolean }} [options]
 * @returns {Promise<object>}
 */
async function getUpdatesStatus(gitRoot = DEFAULT_ROOT, options = {}) {
  const root = path.resolve(gitRoot);
  const gitDir = path.join(root, ".git");
  if (!fs.existsSync(gitDir)) {
    return {
      git_repo: false,
      update_available: false,
      repo_root: root,
      manual_command: null,
      message: "Install directory is not a git clone; check for updates manually.",
    };
  }

  if (!(await hasOrigin(root))) {
    return {
      git_repo: true,
      update_available: false,
      repo_root: root,
      remote_ref: null,
      local_sha: null,
      remote_sha: null,
      commits_behind: 0,
      message: "No origin remote configured; automatic update check skipped.",
    };
  }

  if (!options.skipFetch) {
    try {
      await execGit(root, ["fetch", "origin", "--prune"], { timeout: 120_000 });
    } catch (err) {
      return {
        git_repo: true,
        update_available: false,
        repo_root: root,
        fetch_error: err.message || String(err),
        message: "Could not reach git remote; try again when online.",
      };
    }
  }

  const remoteRef = await resolveCompareRef(root);
  if (!remoteRef) {
    return {
      git_repo: true,
      update_available: false,
      repo_root: root,
      message: "Could not resolve origin/master, origin/main, or origin/HEAD.",
    };
  }

  let localSha;
  let remoteSha;
  let commitsBehind = 0;
  try {
    localSha = await execGit(root, ["rev-parse", "HEAD"], { timeout: 10_000 });
    remoteSha = await execGit(root, ["rev-parse", remoteRef], { timeout: 10_000 });
    const countStr = await execGit(root, ["rev-list", "--count", `HEAD..${remoteRef}`], {
      timeout: 30_000,
    });
    commitsBehind = Number.parseInt(countStr, 10);
    if (Number.isNaN(commitsBehind)) commitsBehind = 0;
  } catch (err) {
    return {
      git_repo: true,
      update_available: false,
      repo_root: root,
      message: err.message || String(err),
    };
  }

  const updateAvailable = commitsBehind > 0;
  const manualParts = [`cd "${root}"`, "git pull --ff-only", "npm run setup"];
  if (process.env.NODE_ENV === "production") {
    manualParts.push("npm run build");
  }
  const manualCommand = manualParts.join(" && ");

  return {
    git_repo: true,
    update_available: updateAvailable,
    repo_root: root,
    remote_ref: remoteRef,
    local_sha: localSha,
    remote_sha: remoteSha,
    commits_behind: commitsBehind,
    manual_command: manualCommand,
    message: updateAvailable
      ? `${commitsBehind} commit(s) on ${remoteRef} not in your checkout.`
      : "Your checkout includes the tip of the tracked upstream branch.",
  };
}

module.exports = { getUpdatesStatus, DEFAULT_ROOT };
