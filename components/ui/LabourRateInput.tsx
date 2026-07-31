"use client";

import { useEffect, useState } from "react";
import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { DollarSign } from "lucide-react";

// Blended hourly rate used to cost logged time when Jobber doesn't supply a
// labour rate on the entry itself. Lives in the URL so it travels with the
// range/segment filters and can be bookmarked.
export default function LabourRateInput({ current }: { current: number | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [value, setValue] = useState(current != null ? String(current) : "");

  useEffect(() => {
    setValue(current != null ? String(current) : "");
  }, [current]);

  function commit() {
    const params = new URLSearchParams(searchParams.toString());
    const parsed = Number(value);
    if (!value.trim() || !Number.isFinite(parsed) || parsed <= 0) {
      params.delete("rate");
    } else {
      params.set("rate", String(parsed));
    }
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <label className="flex h-10 items-center gap-1.5 rounded-md border border-border bg-background px-3 text-sm">
      <DollarSign size={14} className="text-muted-foreground" />
      <input
        type="number"
        min="0"
        step="1"
        inputMode="decimal"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLInputElement).blur();
          }
        }}
        placeholder="Rate"
        aria-label="Blended hourly labour rate"
        className="w-16 bg-transparent font-medium focus:outline-none"
      />
      <span className="text-xs text-muted-foreground">/hr</span>
    </label>
  );
}
