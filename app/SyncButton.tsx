"use client";

import { useState, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { RefreshCw, Loader2 } from "lucide-react";

// Poll cadence + safety cap so a stuck sync doesn't spin the UI forever.
const POLL_MS = 4000;
const MAX_POLL_MS = 20 * 60 * 1000;

export default function SyncButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Clear any pending poll if the component unmounts.
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  function waitForCompletion(): Promise<void> {
    const startedAt = Date.now();
    return new Promise((resolve) => {
      timerRef.current = setInterval(async () => {
        // Give up waiting (the sync may still finish server-side).
        if (Date.now() - startedAt > MAX_POLL_MS) {
          if (timerRef.current) clearInterval(timerRef.current);
          setError(
            "Sync is taking longer than expected — it may still finish in the background. Refresh shortly."
          );
          resolve();
          return;
        }
        try {
          const res = await fetch("/api/sync/status", { cache: "no-store" });
          const body = await res.json().catch(() => ({}));
          const status: string | undefined = body?.run?.status;
          if (status && status !== "running") {
            if (timerRef.current) clearInterval(timerRef.current);
            if (status === "failed") {
              setError(body?.run?.errorMessage ?? "Sync failed");
            }
            resolve();
          }
        } catch {
          // transient network/poll error — keep polling
        }
      }, POLL_MS);
    });
  }

  async function handleSync() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      const body = await res.json().catch(() => ({}));
      // The sync now runs in the background and returns 202 immediately.
      if (!res.ok && res.status !== 202) {
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      await waitForCompletion();
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Sync failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={handleSync}
        disabled={loading}
        variant="accent"
        size="lg"
      >
        {loading ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Syncing… (this may take a few minutes)
          </>
        ) : (
          <>
            <RefreshCw size={16} /> Sync from Jobber
          </>
        )}
      </Button>
      {error && <p className="max-w-md text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
