/**
 * Retry for READ-ONLY GoHighLevel calls.
 *
 * WHY NOT IN `ghlFetch`. That wrapper deliberately refuses to replay anything
 * but a 429, because it carries mutations too and a replayed mutation without
 * an idempotency key can double-send. This helper therefore sits OUTSIDE it,
 * around named read calls only, so the retry can never reach a write.
 *
 * WHAT IS RETRIED. Only failures that carry no answer: a request timeout, a
 * dropped socket, and 5xx. A 4xx is GoHighLevel answering the question - the
 * contact does not exist, the id is wrong, the token lacks the scope - and
 * repeating it would only produce the same answer more slowly.
 *
 * WHAT A FINAL FAILURE MEANS. It throws. A caller that cannot read a history
 * must report an unreadable history and HOLD. This helper exists so a single
 * blip does not stop a whole run; it never turns an unread history into an
 * empty one.
 */

/** Attempts in total, counting the first try. */
const MAX_ATTEMPTS = 4;
/** Backoff before attempt n+1: 500ms, 1s, 2s. */
const BASE_DELAY_MS = 500;

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Does this failure carry no answer, so that asking again could still help? */
export function isRetryableReadFailure(error: unknown): boolean {
  if (!error) return false;
  const status = (error as { status?: unknown }).status;
  if (typeof status === "number") {
    // 5xx is the server failing to answer. Everything else in 4xx IS an answer.
    return status >= 500 && status <= 599;
  }
  const name = String((error as { name?: unknown }).name ?? "");
  if (name === "AbortError" || name === "TimeoutError") return true;
  const message = String((error as { message?: unknown }).message ?? "");
  if (!message) return false;
  return /timeout|timed out|socket hang up|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|network|fetch failed/i
    .test(message);
}

/**
 * Run a read-only GoHighLevel call, retrying only answer-less failures.
 *
 * `onRetry` is for logging a blip that was survived; it must not throw.
 */
export async function withGhlReadRetry<T>(
  label: string,
  read: () => Promise<T>,
  options?: Readonly<{
    attempts?: number;
    onRetry?: (detail: { label: string; attempt: number; error: unknown }) => void;
    delay?: (ms: number) => Promise<void>;
  }>,
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? MAX_ATTEMPTS);
  const wait = options?.delay ?? sleep;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await read();
    } catch (error) {
      lastError = error;
      // An answer, or the last attempt: hand it to the caller to hold on.
      if (attempt === attempts || !isRetryableReadFailure(error)) throw error;
      try { options?.onRetry?.({ label, attempt, error }); } catch { /* logging only */ }
      await wait(BASE_DELAY_MS * 2 ** (attempt - 1));
    }
  }
  // Unreachable: the loop either returns or throws.
  throw lastError;
}
