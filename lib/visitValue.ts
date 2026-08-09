// What one visit to a job is worth.
//
// Jobber prices a RECURRING job per visit: the job total is what the customer
// pays for a single trip, however long the schedule runs. A ONE-OFF job prices
// the whole piece of work, so its total spreads across the visits it takes.
//
// Shared by the dashboard KPIs and the Time Tracking page so the rule lives in
// one place — getting it wrong in only one of them is exactly how the two
// pages started disagreeing before.

export interface ValuedJob {
  total: number;
  isRecurring: boolean;
}

export function perVisitValue(
  job: ValuedJob | null | undefined,
  visitCount: number
): number {
  const total = job?.total ?? 0;
  if (total <= 0) return 0;
  if (job?.isRecurring) return total;
  return visitCount > 0 ? total / visitCount : total;
}
