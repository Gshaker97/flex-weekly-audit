"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Loader2, RefreshCw } from "lucide-react";

// Keeps a server-rendered page honest about its own age.
//
// The dashboard and Time Tracking are plain server-rendered pages: they show
// whatever the database held when they loaded and then hold that view forever.
// The hourly cron sync writes underneath them with nothing to say so, which is
// how a screen ends up eight minutes stale with no hint that it is.
//
// This watches the sync endpoint and does two things: says so while a sync is
// in flight, and refreshes the page once one finishes with data newer than the
// page was built from.

// Checked more often while a sync is running so the refresh lands promptly,
// and rarely otherwise — the status endpoint is a single indexed row, but
// there is no reason to ask every few seconds when nothing is happening.
const POLL_RUNNING_MS = 10_000;
const POLL_IDLE_MS = 30_000;

function elapsedLabel(fromMs: number): string {
  const mins = Math.max(0, Math.floor((Date.now() - fromMs) / 60_000));
  if (mins < 1) return "just started";
  if (mins === 1) return "started 1 minute ago";
  return `started ${mins} minutes ago`;
}

export interface SyncStatusWatcherProps {
  /**
   * When the sync that produced this page finished, in epoch ms. A completed
   * run newer than this means the page is out of date.
   */
  renderedAt: number | null;
}

export default function SyncStatusWatcher({
  renderedAt,
}: SyncStatusWatcherProps) {
  const router = useRouter();
  const [runningSince, setRunningSince] = useState<number | null>(null);
  const [refreshing, setRefreshing] = useState(false);

  // router.refresh() re-renders the server component and hands down a new
  // renderedAt. Tracking it in a ref keeps the polling loop reading the current
  // value without restarting the loop on every render.
  const renderedAtRef = useRef(renderedAt);
  useEffect(() => {
    renderedAtRef.current = renderedAt;
    setRefreshing(false);
  }, [renderedAt]);

  const check = useCallback(async () => {
    // No visibility guard on purpose. Browsers already throttle timers in
    // background tabs, so the saving is negligible, and some embedded views
    // report themselves permanently hidden — which would silently turn this
    // off exactly where a wall-mounted or docked dashboard needs it most.
    try {
      const res = await fetch("/api/sync/status", { cache: "no-store" });
      if (!res.ok) return;
      const body = await res.json();
      const run = body?.run;
      if (!run) return;

      if (run.status === "running") {
        setRunningSince(Date.parse(run.startedAt) || Date.now());
        return;
      }

      setRunningSince(null);
      const completed = run.completedAt ? Date.parse(run.completedAt) : null;
      const seen = renderedAtRef.current;
      if (completed && (seen == null || completed > seen)) {
        // Newer data than this page was built from — pull it in.
        setRefreshing(true);
        router.refresh();
      }
    } catch {
      // Transient network problems are not worth surfacing; the next tick
      // retries and a stale page is the status quo, not a regression.
    }
  }, [router]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout>;
    let cancelled = false;
    const tick = async () => {
      await check();
      if (cancelled) return;
      timer = setTimeout(tick, runningSince ? POLL_RUNNING_MS : POLL_IDLE_MS);
    };
    timer = setTimeout(tick, runningSince ? POLL_RUNNING_MS : POLL_IDLE_MS);
    const onFocus = () => void check();
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onFocus);
    return () => {
      cancelled = true;
      clearTimeout(timer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onFocus);
    };
  }, [check, runningSince]);

  if (!runningSince && !refreshing) return null;

  return (
    <div
      className="flex items-center gap-2 rounded-md border border-warning/30 bg-warning-bg px-3 py-1.5 text-xs font-medium text-warning"
      role="status"
      aria-live="polite"
    >
      {refreshing ? (
        <>
          <RefreshCw size={13} className="animate-spin" />
          Updating with the latest sync…
        </>
      ) : (
        <>
          <Loader2 size={13} className="animate-spin" />
          Syncing from Jobber — {elapsedLabel(runningSince!)}. This page updates
          itself when it finishes.
        </>
      )}
    </div>
  );
}
