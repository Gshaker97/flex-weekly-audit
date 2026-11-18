/**
 * The job behind an invoice, read from Jobber directly.
 *
 * WHY THIS EXISTS: the cache ties jobs to invoices by INVOICE NUMBER, which
 * silently fails for recurring work — one job raises many invoices, so its
 * stored invoice number matches at most one of them. Measured on 2026-11-17:
 * 23 of 55 in-programme invoices could not be tied to a job that way, and the
 * first one due to be emailed was one of them. Jobber knows the real link, so
 * we ask Jobber. That also keeps the settled architecture intact: Jobber is the
 * source of truth about the invoice and its job.
 *
 * Read-only. Both queries start with `query`, issue no mutation, and the caller
 * supplies the transport so nothing here reaches for a token or a client.
 *
 * Two things the live API made clear and this module therefore handles:
 *  - `archivedJobs` RE-LISTS jobs that are already in `jobs`, so results are
 *    deduplicated by job id and "archived" is a flag, not a separate job.
 *  - `Job.notes` is a UNION connection. Client, quote and request notes appear
 *    in it. Only `JobNote` entries clearly refer to the job, so only those are
 *    returned as job text.
 */

/** Both connections are paginated on purpose: an invoice may carry many jobs. */
export const INVOICE_LINKED_JOBS_QUERY = `query InvoiceLinkedJobs($id: EncodedId!, $after: String, $archivedAfter: String) {
  invoice(id: $id) {
    id
    invoiceNumber
    invoiceStatus
    issuedDate
    dueDate
    amounts { total invoiceBalance }
    client { id }
    jobs(first: 25, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { id jobNumber title instructions jobStatus }
    }
    archivedJobs(first: 25, after: $archivedAfter) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { id jobNumber title instructions jobStatus }
    }
  }
}`;

export const JOB_NOTES_QUERY = `query JobNotesForReminder($id: EncodedId!, $after: String) {
  job(id: $id) {
    id
    jobNumber
    notes(first: 50, after: $after) {
      totalCount
      pageInfo { hasNextPage endCursor }
      nodes { __typename ... on JobNote { message pinned } }
    }
  }
}`;

/** Hard page caps. Hitting one is reported as incomplete, never as "all of it". */
const MAX_JOB_PAGES = 10;
const MAX_NOTE_PAGES = 10;

export interface LinkedJob {
  jobId: string;
  jobNumber: string | null;
  jobStatus: string | null;
  archived: boolean;
  title: string | null;
  instructions: string | null;
  /** `JobNote` messages only, trimmed, empties dropped. */
  jobNoteMessages: string[];
  notesTotal: number | null;
  notesRead: number;
  /** Non-JobNote entries seen and deliberately ignored. Reported for honesty. */
  foreignNotes: number;
  notesComplete: boolean;
  notesReason: string | null;
}

export interface LinkedJobsResult {
  invoiceId: string;
  invoiceNumber: string | null;
  invoiceStatus: string | null;
  issuedDate: string | null;
  dueDate: string | null;
  totalCents: number | null;
  balanceCents: number | null;
  clientId: string | null;
  jobs: LinkedJob[];
  /** False when any page cap was hit or any read failed. The caller must hold. */
  complete: boolean;
  reason: string | null;
}

export type JobberReader = (query: string, variables: Record<string, unknown>) => Promise<any>;

function cents(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  const rounded = Math.round(value * 100);
  return Number.isSafeInteger(rounded) && Math.abs(value * 100 - rounded) < 1e-6 ? rounded : null;
}
function str(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

async function readJobNotes(jobId: string, gql: JobberReader) {
  const messages: string[] = [];
  let after: string | null = null;
  let total: number | null = null;
  let read = 0;
  let foreign = 0;
  for (let page = 0; page < MAX_NOTE_PAGES; page += 1) {
    let body: any;
    try { body = await gql(JOB_NOTES_QUERY, { id: jobId, after }); }
    catch (err: any) { return { messages, total, read, foreign, complete: false, reason: `notes_read_threw: ${err?.message ?? "unknown"}` }; }
    if (body?.errors) return { messages, total, read, foreign, complete: false, reason: "notes_read_errored" };
    const notes = body?.data?.job?.notes ?? body?.job?.notes;
    if (!notes) return { messages, total, read, foreign, complete: false, reason: "job_unreadable" };
    total = typeof notes.totalCount === "number" ? notes.totalCount : total;
    for (const node of notes.nodes ?? []) {
      read += 1;
      if (node?.__typename !== "JobNote") { foreign += 1; continue; }
      const message = (str(node.message) ?? "").trim();
      if (message) messages.push(message);
    }
    if (!notes.pageInfo?.hasNextPage) {
      return { messages, total, read, foreign, complete: true, reason: null };
    }
    after = str(notes.pageInfo.endCursor);
    if (!after) return { messages, total, read, foreign, complete: false, reason: "notes_cursor_missing" };
  }
  return { messages, total, read, foreign, complete: false, reason: `notes_exceeded_${MAX_NOTE_PAGES}_pages` };
}

/**
 * Every job Jobber links to this invoice, live and archived, with each job's own
 * notes. Anything that could not be read in full comes back `complete: false`.
 */
export async function readLinkedJobText(invoiceId: string, gql: JobberReader): Promise<LinkedJobsResult> {
  const result: LinkedJobsResult = {
    invoiceId, invoiceNumber: null, invoiceStatus: null, issuedDate: null, dueDate: null,
    totalCents: null, balanceCents: null, clientId: null, jobs: [], complete: true, reason: null,
  };
  // jobId -> node, so a job listed in both connections is one job.
  const seen = new Map<string, { node: any; archived: boolean }>();
  let after: string | null = null;
  let archivedAfter: string | null = null;

  for (let page = 0; page < MAX_JOB_PAGES; page += 1) {
    let body: any;
    try { body = await gql(INVOICE_LINKED_JOBS_QUERY, { id: invoiceId, after, archivedAfter }); }
    catch (err: any) { result.complete = false; result.reason = `jobs_read_threw: ${err?.message ?? "unknown"}`; return result; }
    if (body?.errors) { result.complete = false; result.reason = "jobs_read_errored"; return result; }
    const invoice = body?.data?.invoice ?? body?.invoice;
    if (!invoice || invoice.id !== invoiceId) {
      result.complete = false; result.reason = "invoice_unreadable_or_changed"; return result;
    }
    if (page === 0) {
      result.invoiceNumber = str(invoice.invoiceNumber);
      result.invoiceStatus = str(invoice.invoiceStatus);
      result.issuedDate = str(invoice.issuedDate);
      result.dueDate = str(invoice.dueDate);
      result.totalCents = cents(invoice.amounts?.total);
      result.balanceCents = cents(invoice.amounts?.invoiceBalance);
      result.clientId = str(invoice.client?.id);
    }
    for (const node of invoice.jobs?.nodes ?? []) {
      if (node?.id && !seen.has(node.id)) seen.set(node.id, { node, archived: false });
    }
    for (const node of invoice.archivedJobs?.nodes ?? []) {
      if (!node?.id) continue;
      const existing = seen.get(node.id);
      if (existing) existing.archived = true;
      else seen.set(node.id, { node, archived: true });
    }
    const more = invoice.jobs?.pageInfo?.hasNextPage === true;
    const moreArchived = invoice.archivedJobs?.pageInfo?.hasNextPage === true;
    if (!more && !moreArchived) break;
    if (more) after = str(invoice.jobs.pageInfo.endCursor);
    if (moreArchived) archivedAfter = str(invoice.archivedJobs.pageInfo.endCursor);
    if (page === MAX_JOB_PAGES - 1) { result.complete = false; result.reason = `jobs_exceeded_${MAX_JOB_PAGES}_pages`; }
  }

  for (const [jobId, { node, archived }] of seen) {
    const notes = await readJobNotes(jobId, gql);
    if (!notes.complete) result.complete = false;
    result.jobs.push({
      jobId,
      jobNumber: node.jobNumber == null ? null : String(node.jobNumber),
      jobStatus: str(node.jobStatus),
      archived,
      title: str(node.title),
      instructions: str(node.instructions),
      jobNoteMessages: notes.messages,
      notesTotal: notes.total,
      notesRead: notes.read,
      foreignNotes: notes.foreign,
      notesComplete: notes.complete,
      notesReason: notes.reason,
    });
  }
  return result;
}
