"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Play, Loader2 } from "lucide-react";

export default function RunAuditButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/audit/run", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Request failed (${res.status})`);
      }
      router.refresh();
    } catch (err: any) {
      setError(err?.message ?? "Failed to run audit");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="flex flex-col items-end gap-2">
      <Button
        onClick={handleRun}
        disabled={loading}
        variant="accent"
        size="lg"
      >
        {loading ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Running audit…
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
