"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ChevronLeft, ChevronRight, Calendar as CalendarIcon } from "lucide-react";
import { ALL_PRESETS, presetLabel } from "@/lib/dateRange";

function toYMD(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fromYMD(s: string | null): Date | null {
  if (!s) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
}

function prettyShort(s: string | null): string {
  const d = fromYMD(s);
  if (!d) return "";
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
}

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export default function DateRangeFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const urlStart = searchParams.get("start");
  const urlEnd = searchParams.get("end");
  const isCustom = !!(urlStart || urlEnd);
  const currentPreset = isCustom ? "custom" : searchParams.get("range") ?? "ytd";

  const [open, setOpen] = useState(false);
  const [selStart, setSelStart] = useState<string | null>(urlStart);
  const [selEnd, setSelEnd] = useState<string | null>(urlEnd);
  const [viewDate, setViewDate] = useState<Date>(
    fromYMD(urlStart) ?? new Date()
  );
  const wrapRef = useRef<HTMLDivElement>(null);

  // Keep local selection in sync if the URL changes externally
  useEffect(() => {
    setSelStart(urlStart);
    setSelEnd(urlEnd);
  }, [urlStart, urlEnd]);

  // Close on outside click / Escape
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

  function pushParams(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.push(`${pathname}?${params.toString()}`);
  }

  function handlePreset(next: string) {
    if (next === "custom") return;
    setSelStart(null);
    setSelEnd(null);
    pushParams((p) => {
      p.set("range", next);
      p.delete("start");
      p.delete("end");
    });
  }

  function commitRange(start: string, end: string) {
    pushParams((p) => {
      p.set("start", start);
      p.set("end", end);
      p.set("range", "custom");
    });
    setOpen(false);
  }

  function handleDayClick(ymd: string) {
    // Begin a new range if none in progress or one already complete
    if (!selStart || (selStart && selEnd)) {
      setSelStart(ymd);
      setSelEnd(null);
      return;
    }
    // Second click completes the range (order start/end correctly)
    let start = selStart;
    let end = ymd;
    if (end < start) [start, end] = [end, start];
    setSelStart(start);
    setSelEnd(end);
    commitRange(start, end);
  }

  function clearCustom() {
    setSelStart(null);
    setSelEnd(null);
    pushParams((p) => {
      p.delete("start");
      p.delete("end");
      p.set("range", "ytd");
    });
    setOpen(false);
  }

  // Build the calendar grid for the current view month
  const year = viewDate.getFullYear();
  const month = viewDate.getMonth();
  const firstWeekday = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < firstWeekday; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));

  const selectClass =
    "h-10 rounded-md border border-border bg-background px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent";

  const buttonLabel = isCustom
    ? `${prettyShort(urlStart)} – ${prettyShort(urlEnd)}`
    : selStart && !selEnd
    ? `${prettyShort(selStart)} – …`
    : "Pick dates";

  function inSelectedRange(ymd: string): boolean {
    if (!selStart || !selEnd) return false;
    return ymd >= selStart && ymd <= selEnd;
  }

  return (
    <div ref={wrapRef} className="relative flex flex-wrap items-center gap-2">
      <select
        value={currentPreset}
        onChange={(e) => handlePreset(e.target.value)}
        className={selectClass}
      >
        {ALL_PRESETS.map((p) => (
          <option key={p} value={p}>
            {presetLabel(p)}
          </option>
        ))}
        {isCustom && <option value="custom">Custom range</option>}
      </select>

      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        className={`flex h-10 items-center gap-2 rounded-md border px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent ${
          isCustom ? "border-accent text-foreground" : "border-border text-muted-foreground"
        } bg-background hover:text-foreground`}
      >
        <CalendarIcon size={15} />
        {buttonLabel}
      </button>

      {open && (
        <div className="absolute right-0 top-12 z-50 w-72 rounded-lg border border-border bg-background p-3 shadow-lg">
          <div className="mb-2 flex items-center justify-between">
            <button
              type="button"
              onClick={() => setViewDate(new Date(year, month - 1, 1))}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Previous month"
            >
              <ChevronLeft size={16} />
            </button>
            <span className="text-sm font-semibold">
              {MONTHS[month]} {year}
            </span>
            <button
              type="button"
              onClick={() => setViewDate(new Date(year, month + 1, 1))}
              className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
              aria-label="Next month"
            >
              <ChevronRight size={16} />
            </button>
          </div>

          <div className="grid grid-cols-7 gap-1 text-center text-[10px] uppercase tracking-wide text-muted-foreground">
            {WEEKDAYS.map((w, i) => (
              <div key={i} className="py-1">
                {w}
              </div>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-1">
            {cells.map((cell, i) => {
              if (!cell) return <div key={i} />;
              const ymd = toYMD(cell);
              const isStart = ymd === selStart;
              const isEnd = ymd === selEnd;
              const isEdge = isStart || isEnd;
              const inRange = inSelectedRange(ymd);
              return (
                <button
                  key={i}
                  type="button"
                  onClick={() => handleDayClick(ymd)}
                  className={`h-8 rounded text-xs transition-colors ${
                    isEdge
                      ? "bg-accent font-semibold text-white"
                      : inRange
                      ? "bg-accent/15 text-foreground"
                      : "text-foreground hover:bg-muted"
                  }`}
                >
                  {cell.getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-3 flex items-center justify-between border-t border-border pt-2">
            <span className="text-xs text-muted-foreground">
              {selStart && !selEnd ? "Pick an end date" : "Pick a start and end date"}
            </span>
            <button
              type="button"
              onClick={clearCustom}
              className="text-xs font-medium text-muted-foreground hover:text-foreground"
            >
              Clear
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
