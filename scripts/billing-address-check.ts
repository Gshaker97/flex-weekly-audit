/**
 * READ-ONLY. Does the billing-address path actually produce an address for the
 * customers the preview would create a contact for?
 *
 * The migration is deliberately NOT applied to production, so the four new
 * columns do not exist in the live database and the preview cannot read them.
 * This asks Jobber directly instead, maps the answer with the same pure
 * function the sync now uses, and runs the real resolver, so what it prints is
 * what the contact would actually be created with once the migration is
 * applied and a client sync has run.
 *
 * No write of any kind, and the Jobber token is read, never refreshed.
 *
 * Usage:  tsx scripts/billing-address-check.ts "Name One" "Name Two"
 */
import { jobberBillingAddress, hasBillingAddress } from "../lib/jobber-billing-address";
import { resolvePayers, type ResolverCustomer } from "../lib/ghl-contact-resolution";
import { listContactsForPhoneMatching } from "../lib/ghl";
import { prisma } from "../lib/prisma";

const URL = "https://api.getjobber.com/api/graphql";
const VERSION = "2025-04-16";

async function main() {
  const names = process.argv.slice(2);
  if (!names.length) { console.log("give at least one customer name"); return; }

  const auth = await prisma.jobberAuth.findFirst({ orderBy: { createdAt: "desc" } });
  if (!auth) { console.log("NO JOBBER AUTH STORED"); return; }
  const msLeft = auth.expiresAt.getTime() - Date.now();
  if (msLeft <= 10 * 60 * 1000) {
    console.log("STOPPING: using the stored token would mean refreshing it, which writes. Nothing sent.");
    return;
  }
  const token = auth.accessToken;

  const gql = async (query: string, variables: any = {}, tries = 6): Promise<any> => {
    for (let i = 0; i < tries; i++) {
      const res = await fetch(URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-JOBBER-GRAPHQL-VERSION": VERSION },
        body: JSON.stringify({ query, variables }),
      });
      const j: any = await res.json();
      if ((j.errors ?? []).some((e: any) => e?.extensions?.code === "THROTTLED")) {
        await new Promise(r => setTimeout(r, 12000 * (i + 1)));
        continue;
      }
      if (j.errors) console.log("  GQL ERRORS: " + JSON.stringify(j.errors).slice(0, 400));
      return j.data;
    }
    return null;
  };

  // Exactly the selection the client sync now asks Jobber for.
  const Q = `query($t:String!){ clients(searchTerm:$t, first:5){ nodes {
    id name companyName
    emails { address primary } phones { number primary }
    billingAddress { street1 street2 city province postalCode }
  } } }`;

  const allCustomers: ResolverCustomer[] = (await prisma.customer.findMany()).map(c => ({
    id: c.id, jobberClientId: c.jobberClientId, email: c.email, phone: c.phone,
    name: c.name ?? c.companyName ?? null,
  }));
  const contacts = await listContactsForPhoneMatching();
  console.log(`GoHighLevel snapshot: ${contacts.length} contacts\n`);

  for (const wanted of names) {
    const data = await gql(Q, { t: wanted });
    const node = (data?.clients?.nodes ?? [])[0];
    if (!node) { console.log(`=== ${wanted}: NOT FOUND in Jobber\n`); continue; }

    const billing = jobberBillingAddress(node.billingAddress);
    console.log(`=== ${node.name ?? node.companyName}`);
    console.log(`  Jobber billingAddress raw : ${JSON.stringify(node.billingAddress)}`);
    console.log(`  mapped to the new columns :`);
    console.log(`     billingStreet     ${JSON.stringify(billing.billingStreet)}`);
    console.log(`     billingCity       ${JSON.stringify(billing.billingCity)}`);
    console.log(`     billingState      ${JSON.stringify(billing.billingState)}`);
    console.log(`     billingPostalCode ${JSON.stringify(billing.billingPostalCode)}`);
    console.log(`  has an address: ${hasBillingAddress(billing)}`);

    // Now run the real resolver for this one customer, with the address the
    // sync would have stored, and show the contact it would create.
    const stored = allCustomers.find(c => c.jobberClientId === node.id);
    if (!stored) { console.log(`  (not in the synced customer table)\n`); continue; }
    const withAddress: ResolverCustomer = {
      ...stored,
      address1: billing.billingStreet,
      city: billing.billingCity,
      state: billing.billingState,
      postalCode: billing.billingPostalCode,
    };
    const others = allCustomers.filter(c => c.jobberClientId !== node.id);
    const { creations, holds, payers } = resolvePayers({
      customers: [withAddress], allCustomers: [withAddress, ...others], contacts, cards: [],
    });
    if (creations.length) {
      const made = creations[0];
      console.log(`  WOULD CREATE a GoHighLevel contact:`);
      console.log(`     name        ${made.name}`);
      console.log(`     email       ${made.email ?? "(none)"}`);
      console.log(`     phone       ${made.phone ?? "(none)"}`);
      console.log(`     address1    ${made.address1 ?? "(none)"}`);
      console.log(`     city        ${made.city ?? "(none)"}`);
      console.log(`     state       ${made.state ?? "(none)"}`);
      console.log(`     postalCode  ${made.postalCode ?? "(none)"}`);
    } else if (payers.length) {
      console.log(`  resolves to an EXISTING contact; no creation needed`);
    } else {
      console.log(`  HELD: ${holds[0]?.reason ?? "(no reason)"}`);
    }
    console.log("");
  }

  console.log("READ-ONLY: no mutation sent, no token written, no migration applied.");
}

main()
  .catch(e => console.error("check failed:", e?.message ?? e))
  .finally(() => prisma.$disconnect());
