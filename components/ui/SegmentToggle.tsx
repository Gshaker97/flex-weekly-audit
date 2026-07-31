"use client";

import { useRouter, usePathname, useSearchParams } from "next/navigation";
import { Building2, Home, LayoutGrid } from "lucide-react";
import type { SegmentFilter } from "@/lib/crewSegments";

const OPTIONS: Array<{
  value: SegmentFilter;
  label: string;
  icon: React.ReactNode;
}> = [
  { value: "all", label: "All crews", icon: <LayoutGrid size={14} /> },
  { value: "residential", label: "Residential", icon: <Home size={14} /> },
  { value: "commercial", label: "Commercial", icon: <Building2 size={14} /> },
];

export default function SegmentToggle({ current }: { current: SegmentFilter }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();

  function select(next: SegmentFilter) {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "all") params.delete("segment");
    else params.set("segment", next);
    const qs = params.toString();
    router.push(qs ? `${pathname}?${qs}` : pathname);
  }

  return (
    <div
      role="group"
      aria-label="Crew type"
      className="inline-flex h-10 items-center rounded-md border border-border bg-background p-1"
    >
      {OPTIONS.map((opt) => {
        const active = opt.value === current;
        return (
          <button
            key={opt.value}
            type="button"
            onClick={() => select(opt.value)}
            aria-pressed={active}
            className={`flex h-8 items-center gap-1.5 rounded px-3 text-sm font-medium transition-colors ${
              active
                ? "bg-accent text-accent-foreground"
                : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {opt.icon}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}
