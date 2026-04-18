/**
 * @file Sidebar provider for Claude Code Agent Monitor VSCode extension
 * Provides a dynamic, real-time status overview of the Claude Code Agent backend.
 * Implements background polling to ensure the sidebar reflects the true online/offline status.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

const vscode = require("vscode");
const http = require("http");

/**
 * Enhanced Sidebar Provider for Claude Code Agent Monitor
 * Includes background polling for true real-time status detection.
 */
class DashboardStatusProvider {
  constructor() {
    this._onDidChangeTreeData = new vscode.EventEmitter();
    this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    this.status = "Offline";
    this.data = {};
    this.lastUpdate = 0;

    // Start background polling for status detection
    this.startPolling();
  }

  refresh() {
    this._onDidChangeTreeData.fire();
  }

  /**
   * Periodically updates data in the background to ensure
   * the UI reflects the true state of the server (Online/Offline).
   */
  async startPolling() {
    while (true) {
      const oldStatus = this.status;
      await this.fetchAll(true); // Force fetch

      // If status changed or data updated, fire the change event
      if (this.status !== oldStatus || this.status === "Online") {
        this.refresh();
      }

      // Poll every 5 seconds
      await new Promise((resolve) => setTimeout(resolve, 5000));
    }
  }

  getTreeItem(e) {
    return e;
  }

  async getChildren(e) {
    if (!e) {
      // No need to fetch here anymore as polling handles it
      return [
        new Cat("Monitor Connection", vscode.TreeItemCollapsibleState.Expanded),
        new Cat("Agent Health (Live)", vscode.TreeItemCollapsibleState.Expanded),
        new Cat("Usage & Analytics", vscode.TreeItemCollapsibleState.Expanded),
        new Cat("Recent Sessions", vscode.TreeItemCollapsibleState.Collapsed),
        new Cat("Quick Navigation", vscode.TreeItemCollapsibleState.Expanded),
        new Cat("Actions", vscode.TreeItemCollapsibleState.Expanded),
      ];
    }

    const d = this.data;
    const isOff = this.status === "Offline";

    if (e.label === "Monitor Connection") {
      const icon = isOff ? "circle-outline" : "circle-filled";
      const color = isOff ? "charts.red" : "charts.green";
      return [
        new Item(
          `Backend: ${this.status}`,
          null,
          new vscode.ThemeIcon(icon, new vscode.ThemeColor(color)),
          d.port ? `localhost:${d.port}` : ""
        ),
        new Item(
          `WebSockets: ${d.stats?.ws_connections || 0}`,
          null,
          "pulse",
          "Active connections"
        ),
      ];
    }

    if (e.label === "Agent Health (Live)") {
      if (isOff) return [new Item("Offline", null, "info")];
      const s = d.stats?.agents_by_status || {};
      return [
        new Item(
          `Working: ${s.working || 0}`,
          null,
          new vscode.ThemeIcon("play", new vscode.ThemeColor("charts.blue"))
        ),
        new Item(
          `Connected: ${s.connected || 0}`,
          null,
          new vscode.ThemeIcon("broadcast", new vscode.ThemeColor("charts.purple"))
        ),
        new Item(
          `Idle: ${s.idle || 0}`,
          null,
          new vscode.ThemeIcon("circle-outline", new vscode.ThemeColor("charts.green"))
        ),
        new Item(
          `Completed: ${s.completed || 0}`,
          null,
          new vscode.ThemeIcon("check", new vscode.ThemeColor("charts.foreground"))
        ),
        new Item(
          `Error/Failed: ${s.error || 0}`,
          null,
          new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"))
        ),
      ];
    }

    if (e.label === "Usage & Analytics") {
      if (isOff) return [new Item("Offline", null, "info")];
      const t = d.analytics?.tokens || {};
      const totalTokens =
        (t.total_input || 0) +
        (t.total_output || 0) +
        (t.total_cache_read || 0) +
        (t.total_cache_write || 0);
      const cost = d.analytics?.total_cost || 0;

      return [
        new Item(`Total Tokens: ${this.formatNum(totalTokens)}`, null, "symbol-number"),
        new Item(
          `Total Cost: $${cost.toFixed(2)}`,
          null,
          "credit-card",
          "Calculated across all sessions"
        ),
        new Item(`Total Events: ${this.formatNum(d.stats?.total_events || 0)}`, null, "zap"),
        new Item(`Total Sessions: ${d.stats?.total_sessions || 0}`, null, "history"),
        new Item(`Subagents: ${d.analytics?.total_subagents || 0}`, null, "layers"),
      ];
    }

    if (e.label === "Quick Navigation") {
      return [
        new Item(
          "Main Dashboard",
          { command: "claude-code-agent-monitor.openDashboard", title: "", arguments: [""] },
          "dashboard"
        ),
        new Item(
          "Analytics Hub",
          {
            command: "claude-code-agent-monitor.openDashboard",
            title: "",
            arguments: ["analytics"],
          },
          "graph-line"
        ),
        new Item(
          "Agent Board",
          { command: "claude-code-agent-monitor.openDashboard", title: "", arguments: ["kanban"] },
          "layout"
        ),
        new Item(
          "All Sessions",
          {
            command: "claude-code-agent-monitor.openDashboard",
            title: "",
            arguments: ["sessions"],
          },
          "list-unordered"
        ),
        new Item(
          "System Settings",
          {
            command: "claude-code-agent-monitor.openDashboard",
            title: "",
            arguments: ["settings"],
          },
          "settings-gear"
        ),
      ];
    }

    if (e.label === "Recent Sessions") {
      if (isOff || !d.sessions?.length) return [new Item("No active data", null, "info")];
      return d.sessions.slice(0, 10).map((s) => {
        const icon = s.status === "completed" ? "check" : s.status === "active" ? "play" : "error";
        const item = new Item(
          s.name || s.id.substring(0, 8),
          { command: "claude-code-agent-monitor.openDashboard", title: "", arguments: [s.id] },
          icon
        );
        item.description = s.status;
        item.tooltip = `ID: ${s.id}\nModel: ${s.model || "unknown"}\nStarted: ${new Date(s.started_at).toLocaleString()}`;
        return item;
      });
    }

    if (e.label === "Actions") {
      return [
        new Item(
          "Refresh All Data",
          { command: "claude-code-agent-monitor.refreshStatus", title: "" },
          "refresh"
        ),
        new Item(
          "Open in Browser",
          { command: "claude-code-agent-monitor.openInBrowser", title: "" },
          "globe"
        ),
        new Item(
          "Clear All History",
          { command: "claude-code-agent-monitor.clearHistory", title: "" },
          "trash"
        ),
      ];
    }

    return [];
  }

  async fetchAll(force = false) {
    if (!force && Date.now() - this.lastUpdate < 1000) return;

    const ports = [4820, 5173];
    let foundActive = false;

    for (const p of ports) {
      try {
        const up = await this.ping(p);
        if (up) {
          this.status = "Online";
          this.data.port = p;
          foundActive = true;
          try {
            this.data.stats = await this.f(4820, "/api/stats");
            this.data.analytics = await this.f(4820, "/api/analytics");
            const sess = await this.f(4820, "/api/sessions?limit=10");
            this.data.sessions = sess.rows || sess;
          } catch (e) {}
          break;
        }
      } catch (e) {}
    }

    if (!foundActive) {
      this.status = "Offline";
      this.data = {};
    }

    this.lastUpdate = Date.now();
  }

  formatNum(n) {
    if (n >= 1000000000) return (n / 1000000000).toFixed(2) + "B";
    if (n >= 1000000) return (n / 1000000).toFixed(2) + "M";
    if (n >= 1000) return (n / 1000).toFixed(1) + "k";
    return n.toString();
  }

  ping(p) {
    return new Promise((r) => {
      const req = http.get(
        { hostname: "localhost", port: p, path: p === 4820 ? "/api/health" : "/", timeout: 300 },
        (res) => {
          r(true);
          res.resume();
        }
      );
      req.on("error", () => r(false));
    });
  }

  f(p, path) {
    return new Promise((res, rej) => {
      const req = http.get({ hostname: "localhost", port: p, path, timeout: 800 }, (r) => {
        let d = "";
        r.on("data", (c) => (d += c));
        r.on("end", () => {
          try {
            res(JSON.parse(d));
          } catch (e) {
            rej(e);
          }
        });
      });
      req.on("error", rej);
    });
  }
}

class Cat extends vscode.TreeItem {
  constructor(l, s) {
    super(l, s);
    this.contextValue = "category";
  }
}
class Item extends vscode.TreeItem {
  constructor(l, c, i, d) {
    super(l, vscode.TreeItemCollapsibleState.None);
    this.command = c;
    this.iconPath = typeof i === "string" ? new vscode.ThemeIcon(i) : i;
    this.description = d || "";
  }
}

module.exports = { DashboardStatusProvider };
