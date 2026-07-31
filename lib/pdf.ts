// A tiny, dependency-free PDF writer.
//
// It only needs what the report uses — filled rectangles, rules, and text in
// the two standard Type1 fonts (Helvetica / Helvetica-Bold), which every PDF
// reader ships with, so nothing has to be embedded. Keeping this in-repo means
// no new runtime dependency and no font/asset resolution to go wrong on Railway.
//
// Coordinates exposed here are TOP-LEFT origin (y grows downward); the PDF's
// bottom-left origin is handled internally.

// Glyph widths in 1/1000 em for character codes 32..126 (Adobe AFM metrics).
const W_REGULAR = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584,
  584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278,
  278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222,
  500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500,
  500, 334, 260, 334, 584,
];

const W_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278,
  278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584,
  584, 611, 975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611,
  833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333,
  278, 333, 584, 556, 333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278,
  556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556,
  500, 389, 280, 389, 584,
];

// Map the non-ASCII characters that actually show up in this data (smart
// quotes, dashes, the em dash placeholder) to ASCII, then drop the rest so the
// width tables above always apply.
const REPLACEMENTS: Array<[RegExp, string]> = [
  [/[‘’‛]/g, "'"],
  [/[“”‟]/g, '"'],
  [/[–—−]/g, "-"],
  [/[•·]/g, "-"],
  [/…/g, "..."],
  [/ /g, " "],
];

// Letters that have no ASCII base under NFD decomposition, so they need an
// explicit spelling.
const LIGATURES: Array<[RegExp, string]> = [
  [/æ/g, "ae"],
  [/Æ/g, "AE"],
  [/œ/g, "oe"],
  [/Œ/g, "OE"],
  [/ß/g, "ss"],
  [/ø/g, "o"],
  [/Ø/g, "O"],
  [/[đð]/g, "d"],
  [/[ĐÐ]/g, "D"],
  [/ł/g, "l"],
  [/Ł/g, "L"],
];

export function sanitize(text: string): string {
  let out = text;
  for (const [re, sub] of REPLACEMENTS) out = out.replace(re, sub);
  for (const [re, sub] of LIGATURES) out = out.replace(re, sub);
  // Decompose accents (é -> e + combining acute) and drop the combining marks
  // so the base letter survives — customer and crew names like "Cañada Ridge"
  // or "José" must stay readable rather than losing characters.
  out = out.normalize("NFD").replace(/[̀-ͯ]/g, "");
  // eslint-disable-next-line no-control-regex
  return out.replace(/[^\x20-\x7E]/g, "");
}

export function textWidth(text: string, size: number, bold = false): number {
  const table = bold ? W_BOLD : W_REGULAR;
  let total = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const w = code >= 32 && code <= 126 ? table[code - 32] : table[0];
    total += w;
  }
  return (total * size) / 1000;
}

// Shorten to fit `maxWidth`, appending ".." when characters are dropped.
export function truncateToWidth(
  text: string,
  maxWidth: number,
  size: number,
  bold = false
): string {
  if (textWidth(text, size, bold) <= maxWidth) return text;
  const ellipsis = "..";
  const budget = maxWidth - textWidth(ellipsis, size, bold);
  if (budget <= 0) return "";
  let out = "";
  let width = 0;
  for (const ch of text) {
    const cw = textWidth(ch, size, bold);
    if (width + cw > budget) break;
    out += ch;
    width += cw;
  }
  return out + ellipsis;
}

// Greedy word wrap into lines that each fit `maxWidth`.
export function wrapText(
  text: string,
  maxWidth: number,
  size: number,
  bold = false
): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let line = "";
  for (const word of words) {
    const candidate = line ? `${line} ${word}` : word;
    if (textWidth(candidate, size, bold) <= maxWidth) {
      line = candidate;
    } else {
      if (line) lines.push(line);
      line = textWidth(word, size, bold) > maxWidth
        ? truncateToWidth(word, maxWidth, size, bold)
        : word;
    }
  }
  if (line) lines.push(line);
  return lines;
}

export type RGB = [number, number, number];

export interface TextOptions {
  size?: number;
  bold?: boolean;
  color?: RGB;
  align?: "left" | "right" | "center";
  maxWidth?: number;
}

function escapeString(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
}

function num(n: number): string {
  return (Math.round(n * 100) / 100).toString();
}

function colorOp(c: RGB, stroke = false): string {
  const op = stroke ? "RG" : "rg";
  return `${num(c[0])} ${num(c[1])} ${num(c[2])} ${op}`;
}

export class PdfBuilder {
  readonly width: number;
  readonly height: number;
  private pages: string[][] = [];
  private current: string[] | null = null;

  constructor(width: number, height: number) {
    this.width = width;
    this.height = height;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  addPage(): void {
    this.current = [];
    this.pages.push(this.current);
  }

  private ops(): string[] {
    if (!this.current) this.addPage();
    return this.current as string[];
  }

  /** Draw text with its baseline at `y` measured from the top of the page. */
  text(x: number, y: number, value: string, opts: TextOptions = {}): void {
    const size = opts.size ?? 9;
    const bold = opts.bold ?? false;
    const color = opts.color ?? [0, 0, 0];
    let str = sanitize(value);
    if (opts.maxWidth != null) {
      str = truncateToWidth(str, opts.maxWidth, size, bold);
    }
    if (!str) return;

    let drawX = x;
    if (opts.align === "right") drawX = x - textWidth(str, size, bold);
    else if (opts.align === "center") drawX = x - textWidth(str, size, bold) / 2;

    this.ops().push(
      `BT ${colorOp(color)} /${bold ? "F2" : "F1"} ${num(size)} Tf ` +
        `1 0 0 1 ${num(drawX)} ${num(this.height - y)} Tm ` +
        `(${escapeString(str)}) Tj ET`
    );
  }

  /** Filled rectangle; `y` is the top edge. */
  rect(
    x: number,
    y: number,
    w: number,
    h: number,
    color: RGB = [0, 0, 0]
  ): void {
    this.ops().push(
      `${colorOp(color)} ${num(x)} ${num(this.height - y - h)} ${num(w)} ${num(
        h
      )} re f`
    );
  }

  /** Horizontal or arbitrary rule. */
  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: RGB = [0.8, 0.8, 0.8],
    lineWidth = 0.5
  ): void {
    this.ops().push(
      `${colorOp(color, true)} ${num(lineWidth)} w ${num(x1)} ${num(
        this.height - y1
      )} m ${num(x2)} ${num(this.height - y2)} l S`
    );
  }

  build(): Buffer {
    const pageCount = this.pages.length || 1;
    if (!this.pages.length) this.addPage();

    // Object numbering: 1 catalog, 2 pages, 3/4 fonts, then page+content pairs.
    const FIRST_PAGE_OBJ = 5;
    const objects: string[] = [];
    const kids: string[] = [];
    for (let i = 0; i < pageCount; i++) {
      kids.push(`${FIRST_PAGE_OBJ + i * 2} 0 R`);
    }

    objects[0] = "<< /Type /Catalog /Pages 2 0 R >>";
    objects[1] = `<< /Type /Pages /Count ${pageCount} /Kids [${kids.join(
      " "
    )}] >>`;
    objects[2] =
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>";
    objects[3] =
      "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>";

    for (let i = 0; i < pageCount; i++) {
      const pageObj = FIRST_PAGE_OBJ + i * 2;
      const contentObj = pageObj + 1;
      objects[pageObj - 1] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(this.width)} ${num(
          this.height
        )}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${contentObj} 0 R >>`;
      const stream = this.pages[i].join("\n");
      objects[contentObj - 1] =
        `<< /Length ${Buffer.byteLength(stream, "latin1")} >>\n` +
        `stream\n${stream}\nendstream`;
    }

    let pdf = "%PDF-1.4\n%\xE2\xE3\xCF\xD3\n";
    const offsets: number[] = [];
    for (let i = 0; i < objects.length; i++) {
      offsets[i] = Buffer.byteLength(pdf, "latin1");
      pdf += `${i + 1} 0 obj\n${objects[i]}\nendobj\n`;
    }

    const xrefOffset = Buffer.byteLength(pdf, "latin1");
    pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
    for (const offset of offsets) {
      pdf += `${String(offset).padStart(10, "0")} 00000 n \n`;
    }
    pdf +=
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n` +
      `startxref\n${xrefOffset}\n%%EOF\n`;

    return Buffer.from(pdf, "latin1");
  }
}
