import * as React from "react";
import Link from "next/link";
import { Card } from "./Card";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown, ArrowUpRight } from "lucide-react";

export function ClickableStatCard({
  label,
  value,
  sublabel,
  accent,
  icon,
  href,
  changePercent,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: string;
  accent?: "success" | "warning" | "danger" | "default" | "brand";
  icon?: React.ReactNode;
  href: string;
  changePercent?: number | null;
}) {
  const accentStyles = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    default: "text-foreground",
    brand: "text-accent",
  } as const;
  const a = accent ?? "default";
  return (
    <Link href={href} className="group block">
      <Card className="p-6 transition-all hover:border-accent/40 hover:shadow-md">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <p className="text-sm font-medium text-muted-foreground">{label}</p>
              <ArrowUpRight
                size={14}
                className="text-muted-foreground/50 transition-colors group-hover:text-accent"
              />
            </div>
            <p className={cn("mt-2 text-3xl font-semibold tracking-tight", accentStyles[a])}>
              {value}
            </p>
            {(sublabel || changePercent != null) && (
              <div className="mt-1 flex items-center gap-2">
                {changePercent != null && (
                  <span
                    className={cn(
                      "inline-flex items-center gap-0.5 text-xs font-medium",
                      changePercent >= 0 ? "text-success" : "text-danger"
                    )}
                  >
                    {changePercent >= 0 ? (
                      <TrendingUp size={12} />
                    ) : (
                      <TrendingDown size={12} />
                    )}
                    {changePercent >= 0 ? "+" : ""}
                    {changePercent.toFixed(1)}%
                  </span>
                )}
                {sublabel && (
                  <p className="text-xs text-muted-foreground">{sublabel}</p>
                )}
              </div>
            )}
          </div>
          {icon && (
            <div className={cn("rounded-lg p-2 bg-muted shrink-0", accentStyles[a])}>
              {icon}
            </div>
          )}
        </div>
      </Card>
    </Link>
  );
}
