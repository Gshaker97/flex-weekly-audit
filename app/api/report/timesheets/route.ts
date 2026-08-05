import { NextRequest, NextResponse } from "next/server";
import { resolveDateRange, getDateRange } from "@/lib/dateRange";
import { parseSegmentFilter } from "@/lib/crewSegments";
import { buildTimesheetReport } from "@/lib/timesheetReport";
import { reportFileStem } from "@/lib/report";
import { renderReportCsv } from "@/lib/reportCsv";
import { renderReportPdf } from "@/lib/reportPdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
export const maxDuration = 120;

// Time Tracking report for the selected range, crew filter and hourly rate.
// Same CSV/PDF renderers as the dashboard report, so the two look identical.
export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const format = (sp.get("format") ?? "csv").toLowerCase();

  if (format !== "csv" && format !== "pdf") {
    return NextResponse.json(
      { ok: false, error: "format must be 'csv' or 'pdf'" },
      { status: 400 }
    );
  }

  try {
    // Match the page: with no range params at all it shows all time.
    const hasRange = !!(sp.get("range") || sp.get("start") || sp.get("end"));
    const range = hasRange
      ? resolveDateRange({
          range: sp.get("range") ?? undefined,
          start: sp.get("start") ?? undefined,
          end: sp.get("end") ?? undefined,
        })
      : getDateRange("allTime");

    const parsedRate = Number(sp.get("rate"));
    const manualRate =
      Number.isFinite(parsedRate) && parsedRate > 0 ? parsedRate : null;

    const data = await buildTimesheetReport({
      range,
      segmentFilter: parseSegmentFilter(sp.get("segment")),
      manualRate,
    });

    const segment = parseSegmentFilter(sp.get("segment"));
    const stem = `${reportFileStem(data).replace("flexx-report", "flexx-time")}${
      segment === "all" ? "" : `-${segment}`
    }`;

    const buffer =
      format === "pdf"
        ? renderReportPdf(data)
        : Buffer.from(renderReportCsv(data), "utf8");
    const body = new Uint8Array(buffer);

    return new NextResponse(body, {
      status: 200,
      headers: {
        "Content-Type":
          format === "pdf" ? "application/pdf" : "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${stem}.${format}"`,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("[report/timesheets] failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Report generation failed" },
      { status: 500 }
    );
  }
}
