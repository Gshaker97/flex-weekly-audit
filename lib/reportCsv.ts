import type { CellValue, ColumnType, ReportData } from "./report";

// Renders the full report as a single CSV: a header block, the KPI summary,
// then every detail section one after another with its own column header row.
// Numbers stay raw (unformatted) so the file is usable in Excel/Sheets.

function escape(value: string): string {
  if (/[",\r\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(
    2,
    "0"
  )}-${String(d.getDate()).padStart(2, "0")}`;
}

function ymdhm(d: Date): string {
  return `${ymd(d)} ${String(d.getHours()).padStart(2, "0")}:${String(
    d.getMinutes()
  ).padStart(2, "0")}`;
}

function cell(value: CellValue, type: ColumnType): string {
  if (value == null) return "";
  if (type === "date" && value instanceof Date) return ymd(value);
  if (type === "datetime" && value instanceof Date) return ymdhm(value);
  if (value instanceof Date) return ymd(value);
  if (type === "bool") return value ? "Yes" : "No";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") {
    if (type === "int") return String(Math.round(value));
    if (type === "currency" || type === "number")
      return (Math.round(value * 100) / 100).toFixed(2);
    return String(value);
  }
  return String(value);
}

export function renderReportCsv(data: ReportData): string {
  const lines: string[] = [];
  const row = (...cells: string[]) => lines.push(cells.map(escape).join(","));

  row(`${data.businessName} — ${data.reportTitle ?? "Full Business Report"}`);
  row("Date range", data.rangeLabel);
  row("Range start", ymd(data.rangeStart));
  row("Range end", ymd(data.rangeEnd));
  row("Generated", ymdhm(data.generatedAt));
  row(
    "Last Jobber sync",
    data.lastSyncAt ? ymdhm(data.lastSyncAt) : "Never synced"
  );
  lines.push("");

  row("SUMMARY");
  row("Metric", "Value", "Detail");
  for (const item of data.summary) {
    row(item.label, item.value, item.detail ?? "");
  }
  lines.push("");

  for (const section of data.sections) {
    row(section.title.toUpperCase());
    row(section.description);
    row(`${section.rows.length} row${section.rows.length === 1 ? "" : "s"}`);
    row(...section.columns.map((c) => c.header));
    if (section.rows.length === 0) {
      row("No data in this range");
    } else {
      for (const r of section.rows) {
        row(...r.map((v, i) => cell(v, section.columns[i]?.type ?? "text")));
      }
    }
    lines.push("");
  }

  // BOM so Excel opens UTF-8 correctly; CRLF for maximum spreadsheet compat.
  return "﻿" + lines.join("\r\n") + "\r\n";
}
