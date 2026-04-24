/**
 * @file Tests for dashboard self-update HTTP endpoints.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const os = require("os");
const http = require("http");

const TEST_DB = path.join(os.tmpdir(), `dashboard-updates-${Date.now()}-${process.pid}.db`);
process.env.DASHBOARD_DB_PATH = TEST_DB;

const { createApp, startServer } = require("../index");
const { db } = require("../db");

let server;
let BASE;

function httpFetch(urlPath, options = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, BASE);
    const opts = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method: options.method || "GET",
      headers: { "Content-Type": "application/json", ...options.headers },
    };
    const req = http.request(opts, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = body;
        }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.on("error", reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

before(async () => {
  const app = createApp();
  server = await startServer(app, 0);
  const addr = server.address();
  BASE = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  if (server) server.close();
  if (db) db.close();
  try {
    fs.unlinkSync(TEST_DB);
    fs.unlinkSync(`${TEST_DB}-wal`);
    fs.unlinkSync(`${TEST_DB}-shm`);
  } catch {
    // ignore
  }
});

describe("GET /api/updates/status", () => {
  it("returns update check payload", async () => {
    const res = await httpFetch("/api/updates/status");
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.git_repo, "boolean");
    assert.equal(typeof res.body.update_available, "boolean");
    if (res.body.git_repo) {
      assert.ok(typeof res.body.repo_root === "string");
    }
  });
});

describe("POST /api/updates/check", () => {
  it("returns a fresh update status payload", async () => {
    const res = await httpFetch("/api/updates/check", { method: "POST", body: "{}" });
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.git_repo, "boolean");
    assert.equal(typeof res.body.update_available, "boolean");
  });
});

describe("POST /api/updates/apply", () => {
  it("returns 403 when DASHBOARD_SELF_UPDATE disables self-update", async () => {
    const prev = process.env.DASHBOARD_SELF_UPDATE;
    process.env.DASHBOARD_SELF_UPDATE = "0";
    const res = await httpFetch("/api/updates/apply", {
      method: "POST",
      body: "{}",
    });
    assert.equal(res.status, 403);
    assert.equal(res.body?.error?.code, "SELF_UPDATE_FORBIDDEN");
    if (prev === undefined) delete process.env.DASHBOARD_SELF_UPDATE;
    else process.env.DASHBOARD_SELF_UPDATE = prev;
  });
});
