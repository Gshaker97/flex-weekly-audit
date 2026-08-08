// Flexx runs on Arizona time. Railway's containers are UTC, which put every
// timestamp 7 hours ahead and — worse — bucketed "this week", "today" and
// per-day trip counts against UTC midnight instead of Phoenix midnight.
// The npm scripts set TZ; this is the fallback for any other entrypoint.
// Arizona does not observe DST, so this is a constant UTC-7 year round.
process.env.TZ = process.env.TZ || "America/Phoenix";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
};

module.exports = nextConfig;
