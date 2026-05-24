import * as React from "react";
import { Card } from "./Card";
import { cn } from "@/lib/utils";
import { TrendingUp, TrendingDown } from "lucide-react";

export function StatCard({
  label,
  value,
  sublabel,
  accent,
  icon,
  changePercent,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: string;
  accent?: "success" | "warning" | "danger" | "default" | "brand";
  icon?: React.ReactNode;
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
    <Card className="p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
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
  );
}
