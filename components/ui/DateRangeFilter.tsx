"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ALL_PRESETS, presetLabel } from "@/lib/dateRange";

export default function DateRangeFilter() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const start = searchParams.get("start") ?? "";
  const end = searchParams.get("end") ?? "";
  const isCustom = !!(start || end);
  const currentPreset = isCustom ? "custom" : searchParams.get("range") ?? "ytd";

  function push(mutate: (p: URLSearchParams) => void) {
    const params = new URLSearchParams(searchParams.toString());
    mutate(params);
    router.push(`${pathname}?${params.toString()}`);
  }

  function handlePreset(next: string) {
    if (next === "custom") return; // custom is driven by the date inputs
    push((p) => {
      p.set("range", next);
      p.delete("start");
      p.delete("end");
    });
  }

  function handleDate(which: "start" | "end", value: string) {
    push((p) => {
      if (value) p.set(which, value);
      else p.delete(which);

      const s = which === "start" ? value : p.get("start") ?? "";
      const e = which === "end" ? value : p.get("end") ?? "";

      if (s || e) {
        p.set("range", "custom");
      } else {
        p.delete("range");
        p.delete("start");
        p.delete("end");
      }
    });
  }

  const selectClass =
    "h-10 rounded-md border border-border bg-background px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent";
  const dateClass =
    "h-10 rounded-md border border-border bg-background px-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-accent";

  return (
    <div className="flex flex-wrap items-center gap-2">
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

      <div className="flex items-center gap-1.5">
        <input
          type="date"
          aria-label="From date"
          value={start}
          max={end || undefined}
          onChange={(e) => handleDate("start", e.target.value)}
          className={dateClass}
        />
        <span className="text-xs text-muted-foreground">to</span>
        <input
          type="date"
          aria-label="To date"
          value={end}
          min={start || undefined}
          onChange={(e) => handleDate("end", e.target.value)}
          className={dateClass}
        />
      </div>
    </div>
  );
}
