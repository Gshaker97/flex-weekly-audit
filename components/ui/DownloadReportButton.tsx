"use client";

import { useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Download, FileSpreadsheet, FileText, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/Button";
import { presetLabel, parsePreset } from "@/lib/dateRange";

type Format = "csv" | "pdf";

function prettyShort(s: string | null): string {
  if (!s) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return s;
  return new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3])
  ).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

export default function DownloadReportButton() {
  const searchParams = useSearchParams();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<Format | null>(null);
  const [error, setError] = useState<string | null>(null);
  const wrapRef = useRef<HTMLDivElement>(null);

  const start = searchParams.get("start");
  const end = searchParams.get("end");
  const isCustom = !!(start || end);
  const rangeLabel = isCustom
    ? `${prettyShort(start)} – ${prettyShort(end)}`
    : presetLabel(parsePreset(searchParams.get("range")));

  // Close on outside click / Escape (matches the date picker's behavior).
  useEffect(() => {
    if (!open) return;
    function onDown(e: MouseEvent) {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function filenameFrom(res: Response, fallback: string): string {
    const cd = res.headers.get("Content-Disposition") ?? "";
    const m = /filename="?([^"]+)"?/.exec(cd);
    return m?.[1] ?? fallback;
  }

  async function download(format: Format) {
    setBusy(format);
    setError(null);
    try {
      // Carry the dashboard's active range straight through to the report.
      const params = new URLSearchParams();
      if (start) params.set("start", start);
      if (end) params.set("end", end);
      if (!start && !end) {
        params.set("range", searchParams.get("range") ?? "ytd");
      }
      params.set("format", format);

      const res = await fetch(`/api/report?${params.toString()}`, {
        cache: "no-store",
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body?.error ?? `Report failed (${res.status})`);
      }

      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filenameFrom(res, `flexx-report.${format}`);
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
      setOpen(false);
    } catch (err: any) {
      setError(err?.message ?? "Report failed");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div ref={wrapRef} className="relative flex flex-col items-end gap-2">
      <Button
        onClick={() => setOpen((o) => !o)}
        disabled={busy !== null}
        variant="outline"
        size="lg"
      >
        {busy ? (
          <>
            <Loader2 size={16} className="animate-spin" /> Preparing…
          </>
        ) : (
          <>
            <Download size={16} /> Download Report
          </>
        )}
      </Button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-72 rounded-lg border border-border bg-background p-3 shadow-lg">
          <p className="text-sm font-semibold">Download full report</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Every metric and detail list for{" "}
            <span className="font-medium text-foreground">{rangeLabel}</span>.
            Choose a format:
          </p>

          <div className="mt-3 space-y-2">
            <button
              type="button"
              onClick={() => download("csv")}
              disabled={busy !== null}
              className="flex w-full items-start gap-3 rounded-md border border-border p-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
            >
              <FileSpreadsheet size={18} className="mt-0.5 shrink-0 text-accent" />
              <span>
                <span className="block text-sm font-medium">
                  CSV {busy === "csv" && "…"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Full data, opens in Excel or Sheets
                </span>
              </span>
            </button>

            <button
              type="button"
              onClick={() => download("pdf")}
              disabled={busy !== null}
              className="flex w-full items-start gap-3 rounded-md border border-border p-2.5 text-left transition-colors hover:bg-muted disabled:opacity-50"
            >
              <FileText size={18} className="mt-0.5 shrink-0 text-accent" />
              <span>
                <span className="block text-sm font-medium">
                  PDF {busy === "pdf" && "…"}
                </span>
                <span className="block text-xs text-muted-foreground">
                  Formatted report, ready to print or send
                </span>
              </span>
            </button>
          </div>

          <p className="mt-3 border-t border-border pt-2 text-[11px] text-muted-foreground">
            Change the date range above to change what&apos;s included.
          </p>
        </div>
      )}

      {error && (
        <p className="max-w-xs text-right text-xs text-danger">{error}</p>
      )}
    </div>
  );
}
