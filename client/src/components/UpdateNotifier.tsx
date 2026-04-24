/**
 * @file Modal that tells the user when the dashboard's git checkout is behind
 * its remote and shows the exact command to run in a terminal. The dashboard
 * never pulls or restarts itself — the user copies and runs the command.
 * @author Son Nguyen <hoangson091104@gmail.com>
 */

import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Download, X, Copy, Check, RefreshCw } from "lucide-react";
import { api } from "../lib/api";
import { eventBus } from "../lib/eventBus";
import type { UpdateStatusPayload, WSMessage } from "../lib/types";

const DISMISS_KEY = "agent-monitor-update-dismissed-sha";

function isUpdatePayload(x: unknown): x is UpdateStatusPayload {
  return typeof x === "object" && x !== null && "git_repo" in x && "update_available" in x;
}

function loadDismissedSha(): string | null {
  try {
    return localStorage.getItem(DISMISS_KEY);
  } catch {
    return null;
  }
}

export function UpdateNotifier() {
  const { t } = useTranslation("updates");
  const [status, setStatus] = useState<UpdateStatusPayload | null>(null);
  const [dismissedSha, setDismissedSha] = useState<string | null>(loadDismissedSha);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [checking, setChecking] = useState(false);

  const syncFromPayload = useCallback((s: UpdateStatusPayload) => {
    setStatus(s);
    if (!s.fetch_error) setError(null);
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.updates
      .status()
      .then((s) => {
        if (cancelled) return;
        syncFromPayload(s);
        // Mirror the initial /status into the local event bus so other components
        // (e.g. the Sidebar "Check for updates" button) can react without
        // triggering a second git fetch on mount.
        eventBus.publish({
          type: "update_status",
          data: s,
          timestamp: new Date().toISOString(),
        });
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [syncFromPayload]);

  useEffect(() => {
    return eventBus.subscribe((msg: WSMessage) => {
      if (msg.type !== "update_status") return;
      if (isUpdatePayload(msg.data)) syncFromPayload(msg.data);
    });
  }, [syncFromPayload]);

  // Sidebar's "Check for updates" button fires this to signal that the user
  // wants to see the modal again even if they previously dismissed this SHA.
  useEffect(() => {
    const handler = () => setDismissedSha(null);
    window.addEventListener("dashboard:reset-update-dismissal", handler);
    return () => window.removeEventListener("dashboard:reset-update-dismissal", handler);
  }, []);

  const show = Boolean(
    status?.update_available && status.remote_sha && dismissedSha !== status.remote_sha
  );

  const dismiss = () => {
    if (!status?.remote_sha) return;
    try {
      localStorage.setItem(DISMISS_KEY, status.remote_sha);
    } catch {
      /* ignore */
    }
    setDismissedSha(status.remote_sha);
  };

  const copyCmd = async () => {
    if (!status?.manual_command) return;
    try {
      await navigator.clipboard.writeText(status.manual_command);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* ignore */
    }
  };

  const checkNow = async () => {
    if (checking) return;
    setError(null);
    setChecking(true);
    try {
      const fresh = await api.updates.check();
      syncFromPayload(fresh);
    } catch (e) {
      setError(e instanceof Error ? e.message : t("checkError"));
    } finally {
      setChecking(false);
    }
  };

  if (!show || !status) return null;

  const refLabel = status.remote_ref || "origin";
  const behind = status.commits_behind ?? 0;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/55"
      role="dialog"
      aria-modal="true"
      aria-labelledby="update-notifier-title"
    >
      <div className="w-full max-w-lg rounded-xl border border-border bg-surface-2 shadow-2xl p-6 space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-2 text-emerald-400">
            <Download className="w-5 h-5 shrink-0" aria-hidden />
            <h2 id="update-notifier-title" className="text-lg font-semibold text-gray-100">
              {t("title")}
            </h2>
          </div>
          <button
            type="button"
            onClick={dismiss}
            className="p-1.5 rounded-lg text-gray-400 hover:text-gray-200 hover:bg-surface-0 border border-transparent hover:border-border transition-colors"
            aria-label={t("dismiss")}
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <p className="text-sm text-gray-300 leading-relaxed">{t("lead")}</p>

        <p className="text-sm font-mono text-amber-200/90">
          {t("commitsBehind", { count: behind, ref: refLabel })}
        </p>

        {status.fetch_error ? <p className="text-sm text-amber-300/90">{t("fetchError")}</p> : null}

        {!status.git_repo ? <p className="text-sm text-gray-400">{t("notGit")}</p> : null}

        {status.manual_command ? (
          <div className="rounded-lg border border-border bg-surface-0 p-3 text-xs font-mono text-gray-300 break-all">
            {status.manual_command}
          </div>
        ) : null}

        <p className="text-xs text-gray-500">{t("restartNote")}</p>

        {error ? <p className="text-sm text-red-400">{error}</p> : null}

        <div className="flex flex-wrap gap-2 pt-1">
          {status.manual_command ? (
            <button
              type="button"
              onClick={copyCmd}
              disabled={copied}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-medium hover:bg-emerald-500 disabled:opacity-60 transition-colors"
            >
              {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
              {copied ? t("copied") : t("copy")}
            </button>
          ) : null}
          <button
            type="button"
            onClick={checkNow}
            disabled={checking}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border bg-surface-0 text-sm text-gray-200 hover:border-emerald-500/40 hover:bg-emerald-500/10 transition-colors disabled:opacity-60"
          >
            <RefreshCw className={`w-4 h-4 ${checking ? "animate-spin" : ""}`} aria-hidden />
            {checking ? t("checking") : t("checkNow")}
          </button>
          <button
            type="button"
            onClick={dismiss}
            className="inline-flex items-center px-4 py-2 rounded-lg border border-border text-sm text-gray-300 hover:bg-surface-0 transition-colors"
          >
            {t("dismiss")}
          </button>
        </div>
      </div>
    </div>
  );
}
