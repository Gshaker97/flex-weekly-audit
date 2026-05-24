"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/Button";
import { Play, Loader2 } from "lucide-react";

const RANGES = [
  { value: "ytd", label: "Year to date" },
  { value: "last90", label: "Last 90 days" },
  { value: "last30", label: "Last 30 days" },
  { value: "thisWeek", label: "This week" },
  { value: "lastWeek", label: "Last week" },
] as const;

export default function RunAuditButton() {
  const router = useRouter();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [range, setRange] = useState<string>("ytd");

  async function handleRun() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/audit/run?range=${range}`, {
        method: "POST",
      });
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
      <div className="flex items-center gap-2">
        <select
          value={range}
          onChange={(e) => setRange(e.target.value)}
          disabled={loading}
          className="h-11 rounded-md border border-border bg-background px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent"
        >
          {RANGES.map((r) => (
            <option key={r.value} value={r.value}>
              {r.label}
            </option>
          ))}
        </select>
        <Button onClick={handleRun} disabled={loading} variant="accent" size="lg">
          {loading ? (
            <>
              <Loader2 size={16} className="animate-spin" /> Running…
            </>
          ) : (
            <>
              <Play size={16} /> Run audit
            </>
          )}
        </Button>
      </div>
      {error && <p className="max-w-md text-right text-xs text-danger">{error}</p>}
    </div>
  );
}
