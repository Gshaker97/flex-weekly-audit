import { NextRequest, NextResponse } from "next/server";
import { resolveDateRange } from "@/lib/dateRange";
import { buildReport, reportFileStem } from "@/lib/report";
import { renderReportCsv } from "@/lib/reportCsv";
import { renderReportPdf } from "@/lib/reportPdf";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
// A wide range pulls a lot of rows; give it room beyond the default.
export const maxDuration = 120;

// Full business report for the selected date range, as CSV or PDF.
// Query params mirror the dashboard's: ?range=ytd | ?start=YYYY-MM-DD&end=YYYY-MM-DD
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
    const range = resolveDateRange({
      range: sp.get("range") ?? undefined,
      start: sp.get("start") ?? undefined,
      end: sp.get("end") ?? undefined,
    });

    const data = await buildReport(range);
    const filename = `${reportFileStem(data)}.${format}`;

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
        "Content-Disposition": `attachment; filename="${filename}"`,
        "Content-Length": String(body.byteLength),
        "Cache-Control": "no-store",
      },
    });
  } catch (err: any) {
    console.error("[report] failed", err);
    return NextResponse.json(
      { ok: false, error: err?.message ?? "Report generation failed" },
      { status: 500 }
    );
  }
}
