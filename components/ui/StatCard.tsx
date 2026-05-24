import * as React from "react";
import { Card } from "./Card";
import { cn } from "@/lib/utils";

export function StatCard({
  label,
  value,
  sublabel,
  accent,
  icon,
}: {
  label: string;
  value: React.ReactNode;
  sublabel?: string;
  accent?: "success" | "warning" | "danger" | "default";
  icon?: React.ReactNode;
}) {
  const accentStyles = {
    success: "text-success",
    warning: "text-warning",
    danger: "text-danger",
    default: "text-foreground",
  } as const;
  const a = accent ?? "default";
  return (
    <Card className="p-6">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-sm font-medium text-muted-foreground">{label}</p>
          <p className={cn("mt-2 text-3xl font-semibold tracking-tight", accentStyles[a])}>
            {value}
          </p>
          {sublabel && (
            <p className="mt-1 text-xs text-muted-foreground">{sublabel}</p>
          )}
        </div>
        {icon && (
          <div className={cn("rounded-lg p-2", accentStyles[a], "bg-muted")}>
            {icon}
          </div>
        )}
      </div>
    </Card>
  );
}
