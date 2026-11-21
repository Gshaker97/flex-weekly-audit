import { createHash } from 'node:crypto';
import { AuditFailure, LIMITS } from './core';
/** Keep individual Railway log lines small. A final manifest proves all parts. */
export function reportLines(report: unknown): string[] {
  const text = JSON.stringify(report);
  const bytes = Buffer.byteLength(text);
  if (bytes > LIMITS.outputBytes) throw new AuditFailure('OUTPUT_BYTE_LIMIT');
  const sha256 = createHash('sha256').update(text).digest('hex');
  const chunks: string[] = [];
  // JSON data is deliberately ASCII except for constant documentation strings.
  // Code-point slicing also makes this safe for future Unicode additions.
  let chunk = '', chunkBytes = 0;
  for (const point of text) {
    const n = Buffer.byteLength(JSON.stringify(point)) - 2;
    if (chunkBytes + n > 5_000) { chunks.push(chunk); chunk = ''; chunkBytes = 0; }
    chunk += point; chunkBytes += n;
  }
  if (chunk) chunks.push(chunk);
  return [
    ...chunks.map((payload, index) => JSON.stringify({ audit: 'jobber-source-v1', event: 'report-part', index, parts: chunks.length, sha256, payload })),
    JSON.stringify({ audit: 'jobber-source-v1', event: 'report-complete', parts: chunks.length, bytes, sha256 }),
  ];
}
