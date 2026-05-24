"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { RefreshCw, Loader2 } from "lucide-react";

export default function SyncButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleSync() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/sync/run", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
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
