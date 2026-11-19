"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Play, Loader2 } from "lucide-react";

export default function RunDailyAuditButton({ running }: { running: boolean }) {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While a run is in progress, refresh every 15s until the report lands.
  useEffect(() => {
    if (!running) return;
    const t = setInterval(() => router.refresh(), 15_000);
    return () => clearInterval(t);
  }, [running, router]);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/daily-audit/run", { method: "POST" });
      if (!res.ok) throw new Error(`Request failed (${res.status})`);
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Couldn't start the audit");
    } finally {
      setLoading(false);
    }
  }

  const busy = loading || running;
  return (
    <div className="flex flex-col items-end gap-2">
      <Button onClick={handleRun} disabled={busy} variant="accent" size="lg">
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Running…
          </>
        ) : (
          <>
            <Play size={16} /> Run audit now
          </>
        )}
      </Button>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
