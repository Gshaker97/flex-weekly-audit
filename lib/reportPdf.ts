import { PdfBuilder, textWidth, wrapText } from "./pdf";
import type { RGB } from "./pdf";
import type {
  CellValue,
  ColumnType,
  ReportData,
  ReportSection,
} from "./report";
import {
  formatCurrencyDetailed,
  formatDate,
  formatDateTime,
  formatNumber,
} from "./utils";

// Letter, landscape — the detail tables are wide.
const PAGE_W = 792;
const PAGE_H = 612;
const MARGIN = 36;
const CONTENT_W = PAGE_W - MARGIN * 2;
const CONTENT_TOP = 56;
const CONTENT_BOTTOM = PAGE_H - 34;

// Detail tables are capped in the PDF so a wide range can't produce a
// several-hundred-page document. The CSV is never capped, and a note points
// there whenever rows are dropped.
const MAX_ROWS_PER_SECTION = 400;

const GREEN: RGB = [0.42, 0.86, 0.16];
const INK: RGB = [0.06, 0.09, 0.16];
const MUTED: RGB = [0.4, 0.46, 0.55];
const BORDER: RGB = [0.88, 0.91, 0.94];
const BAND: RGB = [0.94, 0.96, 0.98];
const ZEBRA: RGB = [0.975, 0.98, 0.99];

const ROW_H = 14;
const HEADER_H = 17;
const CELL_PAD = 5;
const BODY_SIZE = 7.5;

function formatCell(value: CellValue, type: ColumnType): string {
  if (value == null) return "—";
  if (type === "bool" || typeof value === "boolean") return value ? "Yes" : "No";
  if (value instanceof Date) {
    return type === "datetime" ? formatDateTime(value) : formatDate(value);
  }
  if (typeof value === "number") {
    if (type === "currency") return formatCurrencyDetailed(value);
    if (type === "int") return formatNumber(Math.round(value));
    if (type === "number")
      return formatNumber(Math.round(value * 100) / 100);
    return String(value);
  }
  const str = String(value).trim();
  return str.length ? str : "—";
}

function isNumericType(type: ColumnType): boolean {
  return type === "currency" || type === "number" || type === "int";
}

/**
 * Column widths from content: measure each column's natural width, then scale
 * or pad the whole set to exactly fill the content area.
 */
function columnWidths(section: ReportSection, rowsShown: CellValue[][]): number[] {
  const MIN_W = 34;
  const MAX_W = 190;
  const sample = rowsShown.slice(0, 300);

  const natural = section.columns.map((col, i) => {
    let w = textWidth(col.header, BODY_SIZE, true);
    for (const row of sample) {
      const cw = textWidth(formatCell(row[i], col.type), BODY_SIZE);
      if (cw > w) w = cw;
    }
    return Math.min(MAX_W, Math.max(MIN_W, w + CELL_PAD * 2));
  });

  const total = natural.reduce((a, b) => a + b, 0);
  if (total === CONTENT_W) return natural;

  if (total > CONTENT_W) {
    // Shrink only what's above the minimum, proportionally.
    const shrinkable = natural.map((w) => Math.max(0, w - MIN_W));
    const shrinkTotal = shrinkable.reduce((a, b) => a + b, 0);
    const excess = total - CONTENT_W;
    if (shrinkTotal <= 0) return natural;
    const ratio = Math.min(1, excess / shrinkTotal);
    return natural.map((w, i) => w - shrinkable[i] * ratio);
  }

  // Extra room: give it to the text columns, which are the ones that truncate.
  const textCols = section.columns
    .map((c, i) => (isNumericType(c.type) ? -1 : i))
    .filter((i) => i >= 0);
  const targets = textCols.length
    ? textCols
    : section.columns.map((_, i) => i);
  const extra = (CONTENT_W - total) / targets.length;
  return natural.map((w, i) => (targets.includes(i) ? w + extra : w));
}

export function renderReportPdf(data: ReportData): Buffer {
  // Page numbers need the total up front, so lay the document out once to count
  // pages and again to draw the real footers. The layout is deterministic, so
  // both passes produce the same page breaks.
  const probe = layout(data, null);
  return layout(data, probe.pageCount).build();
}

function layout(data: ReportData, totalPages: number | null): PdfBuilder {
  const pdf = new PdfBuilder(PAGE_W, PAGE_H);
  let y = 0;

  const metaLine =
    `Generated ${formatDateTime(data.generatedAt)}  ·  ` +
    (data.lastSyncAt
      ? `Jobber data synced ${formatDateTime(data.lastSyncAt)}`
      : "Never synced");

  function startPage() {
    pdf.addPage();
    pdf.rect(0, 0, PAGE_W, 3, GREEN);
    pdf.text(MARGIN, 26, `${data.businessName} — Full Business Report`, {
      size: 10,
      bold: true,
      color: INK,
    });
    pdf.text(PAGE_W - MARGIN, 26, data.rangeLabel, {
      size: 9,
      color: MUTED,
      align: "right",
      maxWidth: CONTENT_W / 2,
    });
    pdf.line(MARGIN, 34, PAGE_W - MARGIN, 34, BORDER);

    pdf.line(MARGIN, PAGE_H - 30, PAGE_W - MARGIN, PAGE_H - 30, BORDER);
    pdf.text(MARGIN, PAGE_H - 19, metaLine, { size: 7, color: MUTED });
    pdf.text(
      PAGE_W - MARGIN,
      PAGE_H - 19,
      totalPages == null
        ? `Page ${pdf.pageCount}`
        : `Page ${pdf.pageCount} of ${totalPages}`,
      { size: 7, color: MUTED, align: "right" }
    );

    y = CONTENT_TOP;
  }

  function ensure(space: number) {
    if (y + space > CONTENT_BOTTOM) startPage();
  }

  startPage();

  // ------------------------------------------------------------- title block
  pdf.text(MARGIN, y + 18, "Full Business Report", {
    size: 21,
    bold: true,
    color: INK,
  });
  y += 30;
  pdf.text(
    MARGIN,
    y + 10,
    `${data.rangeLabel}  ·  ${formatDate(data.rangeStart)} – ${formatDate(
      data.rangeEnd
    )}`,
    { size: 10, color: MUTED }
  );
  y += 26;

  // ----------------------------------------------------------------- summary
  pdf.text(MARGIN, y + 9, "SUMMARY", { size: 9, bold: true, color: MUTED });
  y += 18;

  const COLS = 4;
  const GAP = 10;
  const boxW = (CONTENT_W - GAP * (COLS - 1)) / COLS;
  const boxH = 58;
  for (let i = 0; i < data.summary.length; i++) {
    const col = i % COLS;
    if (col === 0) ensure(boxH + GAP);
    const item = data.summary[i];
    const x = MARGIN + col * (boxW + GAP);
    pdf.rect(x, y, boxW, boxH, BAND);
    pdf.rect(x, y, 2.5, boxH, GREEN);
    pdf.text(x + 10, y + 14, item.label.toUpperCase(), {
      size: 6.5,
      bold: true,
      color: MUTED,
      maxWidth: boxW - 16,
    });
    pdf.text(x + 10, y + 31, item.value, {
      size: 14,
      bold: true,
      color: INK,
      maxWidth: boxW - 16,
    });
    if (item.detail) {
      const lines = wrapText(item.detail, boxW - 16, 6.5).slice(0, 2);
      lines.forEach((line, li) => {
        pdf.text(x + 10, y + 43 + li * 8, line, { size: 6.5, color: MUTED });
      });
    }
    if (col === COLS - 1 || i === data.summary.length - 1) y += boxH + GAP;
  }
  y += 8;

  // ---------------------------------------------------------------- sections
  for (const section of data.sections) {
    const rowsShown = section.rows.slice(0, MAX_ROWS_PER_SECTION);
    const dropped = section.rows.length - rowsShown.length;
    const widths = columnWidths(section, rowsShown);
    const descLines = wrapText(section.description, CONTENT_W, 7.5);

    // Keep the heading with at least a couple of rows rather than orphaning it.
    ensure(26 + descLines.length * 9 + HEADER_H + ROW_H * 2);

    pdf.text(MARGIN, y + 11, section.title, {
      size: 12,
      bold: true,
      color: INK,
    });
    pdf.text(
      PAGE_W - MARGIN,
      y + 11,
      `${formatNumber(section.rows.length)} row${
        section.rows.length === 1 ? "" : "s"
      }`,
      { size: 8, color: MUTED, align: "right" }
    );
    y += 18;
    for (const line of descLines) {
      pdf.text(MARGIN, y + 7, line, { size: 7.5, color: MUTED });
      y += 9;
    }
    y += 4;

    if (rowsShown.length === 0) {
      pdf.text(MARGIN, y + 9, "No data in this range.", {
        size: 8,
        color: MUTED,
      });
      y += 22;
      continue;
    }

    function drawHeaderRow() {
      pdf.rect(MARGIN, y, CONTENT_W, HEADER_H, BAND);
      let x = MARGIN;
      section.columns.forEach((col, i) => {
        const right = isNumericType(col.type);
        pdf.text(
          right ? x + widths[i] - CELL_PAD : x + CELL_PAD,
          y + 11.5,
          col.header,
          {
            size: BODY_SIZE,
            bold: true,
            color: INK,
            align: right ? "right" : "left",
            maxWidth: widths[i] - CELL_PAD * 2,
          }
        );
        x += widths[i];
      });
      pdf.line(MARGIN, y + HEADER_H, PAGE_W - MARGIN, y + HEADER_H, BORDER);
      y += HEADER_H;
    }

    drawHeaderRow();

    rowsShown.forEach((row, ri) => {
      if (y + ROW_H > CONTENT_BOTTOM) {
        startPage();
        pdf.text(MARGIN, y + 10, `${section.title} (continued)`, {
          size: 10,
          bold: true,
          color: INK,
        });
        y += 18;
        drawHeaderRow();
      }
      if (ri % 2 === 1) pdf.rect(MARGIN, y, CONTENT_W, ROW_H, ZEBRA);
      let x = MARGIN;
      section.columns.forEach((col, ci) => {
        const value = formatCell(row[ci], col.type);
        const right = isNumericType(col.type);
        pdf.text(
          right ? x + widths[ci] - CELL_PAD : x + CELL_PAD,
          y + 9.5,
          value,
          {
            size: BODY_SIZE,
            color: value === "—" ? MUTED : INK,
            align: right ? "right" : "left",
            maxWidth: widths[ci] - CELL_PAD * 2,
          }
        );
        x += widths[ci];
      });
      y += ROW_H;
    });

    pdf.line(MARGIN, y, PAGE_W - MARGIN, y, BORDER);
    y += 6;

    if (dropped > 0) {
      ensure(14);
      pdf.text(
        MARGIN,
        y + 8,
        `+ ${formatNumber(dropped)} more row${
          dropped === 1 ? "" : "s"
        } not shown — download the CSV for the complete list.`,
        { size: 7.5, color: MUTED }
      );
      y += 12;
    }
    y += 12;
  }

  return pdf;
}
