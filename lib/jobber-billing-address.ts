/**
 * Jobber's billing address, reduced to the four fields a GoHighLevel contact
 * carries: street, city, state, postal code.
 *
 * Pure, so the sync's reading of Jobber and the contact writer's use of it can
 * both be exercised without touching either system.
 *
 * Two decisions worth stating, because both are easy to get wrong silently:
 *
 *   BLANK IS NULL. Jobber returns "" and "   " for fields nobody filled in.
 *   Stored as-is they would look like a synced address that happens to be
 *   empty, and a created contact would carry a blank street. Every field is
 *   therefore trimmed, and anything with nothing left becomes null, so "Jobber
 *   has nothing" and "nobody has synced this yet" stay the same shape - absent.
 *
 *   TWO STREET LINES BECOME ONE. GoHighLevel's contact has a single `address1`.
 *   Jobber has `street1` and `street2` (unit, suite, apartment). Dropping
 *   street2 would send a courier to the wrong door of the right building, so
 *   the two are joined with a comma. Either one alone is used on its own.
 */

export type JobberBillingAddressSource = Readonly<{
  street1?: string | null;
  street2?: string | null;
  city?: string | null;
  province?: string | null;
  postalCode?: string | null;
}> | null | undefined;

export type BillingAddress = Readonly<{
  billingStreet: string | null;
  billingCity: string | null;
  billingState: string | null;
  billingPostalCode: string | null;
}>;

export const EMPTY_BILLING_ADDRESS: BillingAddress = Object.freeze({
  billingStreet: null, billingCity: null, billingState: null, billingPostalCode: null,
});

/** Trimmed, or null when there is nothing left. Never an empty string. */
export function billingField(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length ? trimmed : null;
}

/** Jobber's two street lines as GoHighLevel's one, in order, comma separated. */
export function billingStreetLine(
  street1: unknown, street2: unknown,
): string | null {
  const parts = [billingField(street1), billingField(street2)].filter((p): p is string => !!p);
  return parts.length ? parts.join(", ") : null;
}

/** The whole address, or all-null when Jobber has none. */
export function jobberBillingAddress(source: JobberBillingAddressSource): BillingAddress {
  if (!source || typeof source !== "object") return EMPTY_BILLING_ADDRESS;
  return Object.freeze({
    billingStreet: billingStreetLine(source.street1, source.street2),
    billingCity: billingField(source.city),
    billingState: billingField(source.province),
    billingPostalCode: billingField(source.postalCode),
  });
}

/** True when Jobber gave us at least one usable line. */
export function hasBillingAddress(address: BillingAddress): boolean {
  return !!(address.billingStreet || address.billingCity
    || address.billingState || address.billingPostalCode);
}
