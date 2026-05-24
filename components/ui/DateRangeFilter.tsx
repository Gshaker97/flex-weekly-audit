"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { ALL_PRESETS, DateRangePreset, presetLabel } from "@/lib/dateRange";

export default function DateRangeFilter({
  current,
}: {
  current: DateRangePreset;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function handleChange(next: string) {
    const params = new URLSearchParams(searchParams.toString());
    params.set("range", next);
    router.push(`${pathname}?${params.toString()}`);
  }

  return (
    <select
      value={current}
      onChange={(e) => handleChange(e.target.value)}
      className="h-10 rounded-md border border-border bg-background px-3 text-sm font-medium focus:outline-none focus:ring-2 focus:ring-accent"
    >
      {ALL_PRESETS.map((p) => (
        <option key={p} value={p}>
          {presetLabel(p)}
        </option>
      ))}
    </select>
  );
}
