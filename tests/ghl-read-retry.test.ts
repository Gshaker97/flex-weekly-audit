import test from "node:test";
import assert from "node:assert/strict";
import { isRetryableReadFailure, withGhlReadRetry } from "../lib/ghl-read-retry";

/** No real waiting: the backoff is replaced so the suite stays fast. */
const noDelay = async () => {};

const statusError = (status: number) => Object.assign(new Error(`GHL API ${status}`), { status });

test("only answer-less failures are retryable", () => {
  // No answer: worth asking again.
  assert.equal(isRetryableReadFailure(new Error("GHL API timeout after 10000ms (/contacts)")), true);
  assert.equal(isRetryableReadFailure(new Error("fetch failed")), true);
  assert.equal(isRetryableReadFailure(new Error("socket hang up")), true);
  assert.equal(isRetryableReadFailure(new Error("read ECONNRESET")), true);
  assert.equal(isRetryableReadFailure(Object.assign(new Error("x"), { name: "AbortError" })), true);
  assert.equal(isRetryableReadFailure(statusError(500)), true);
  assert.equal(isRetryableReadFailure(statusError(503)), true);
  // An answer: asking again just repeats it.
  assert.equal(isRetryableReadFailure(statusError(404)), false);
  assert.equal(isRetryableReadFailure(statusError(401)), false);
  assert.equal(isRetryableReadFailure(statusError(403)), false);
  assert.equal(isRetryableReadFailure(statusError(422)), false);
  assert.equal(isRetryableReadFailure(new Error("something unrecognised")), false);
  assert.equal(isRetryableReadFailure(null), false);
});

test("a read that works first time is called exactly once", async () => {
  let calls = 0;
  const value = await withGhlReadRetry("history", async () => { calls++; return "ok"; },
    { delay: noDelay });
  assert.equal(value, "ok");
  assert.equal(calls, 1);
});

test("a timeout is survived and the run continues", async () => {
  let calls = 0;
  const retries: number[] = [];
  const value = await withGhlReadRetry("history", async () => {
    calls++;
    if (calls < 3) throw new Error("GHL API timeout after 10000ms (/conversations)");
    return "history";
  }, { delay: noDelay, onRetry: detail => retries.push(detail.attempt) });
  assert.equal(value, "history");
  assert.equal(calls, 3);
  assert.deepEqual(retries, [1, 2]);
});

test("a 404 is NOT retried: GoHighLevel already answered", async () => {
  let calls = 0;
  await assert.rejects(
    withGhlReadRetry("history", async () => { calls++; throw statusError(404); }, { delay: noDelay }),
    /GHL API 404/);
  assert.equal(calls, 1, "an answer must not be asked for again");
});

test("exhausting the attempts THROWS, so the caller holds rather than seeing no history", async () => {
  let calls = 0;
  await assert.rejects(
    withGhlReadRetry("history", async () => { calls++; throw new Error("fetch failed"); },
      { delay: noDelay }),
    /fetch failed/);
  assert.equal(calls, 4, "four attempts in total");
  // The point of the assertion above: a persistent failure must never resolve
  // to an empty history, which would read as "nothing was ever sent".
});

test("a throwing logger cannot break the retry", async () => {
  let calls = 0;
  const value = await withGhlReadRetry("history", async () => {
    calls++;
    if (calls < 2) throw new Error("fetch failed");
    return "ok";
  }, { delay: noDelay, onRetry: () => { throw new Error("logger exploded"); } });
  assert.equal(value, "ok");
  assert.equal(calls, 2);
});

test("the backoff grows, and is awaited between attempts", async () => {
  const waits: number[] = [];
  let calls = 0;
  await withGhlReadRetry("history", async () => {
    calls++;
    if (calls < 4) throw new Error("fetch failed");
    return "ok";
  }, { delay: async ms => { waits.push(ms); } });
  assert.deepEqual(waits, [500, 1000, 2000]);
});
