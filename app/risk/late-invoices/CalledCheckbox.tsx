"use client";

import { useState } from "react";
import { setInvoiceCalled } from "./actions";

export function CalledCheckbox({ invoiceId, initial, calledBy, calledAt }: {
  invoiceId: string;
  initial: boolean;
  calledBy: string | null;
  calledAt: string | null;
}) {
  const [checked, setChecked] = useState(initial);
  const [legacyCaller, setLegacyCaller] = useState(calledBy);
  const [markedAt, setMarkedAt] = useState(calledAt);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <div className="space-y-1">
      <label className="inline-flex items-center gap-2">
        <input
          type="checkbox"
          aria-label={`Manually mark call for invoice ${invoiceId}`}
          checked={checked}
          disabled={pending}
          onChange={async (e) => {
            const value = e.target.checked;
            setError(null);
            setPending(true);
            try {
              await setInvoiceCalled(invoiceId, value);
              setChecked(value);
              setLegacyCaller(null);
              setMarkedAt(null);
            } catch {
              setError("Could not save. Please retry.");
            } finally {
              setPending(false);
            }
          }}
          className="h-4 w-4 cursor-pointer rounded border-border accent-green-600"
        />
        <span className="text-xs text-muted-foreground">{pending ? "Saving…" : checked ? "Manually marked" : "Not marked"}</span>
      </label>
      {checked && legacyCaller && (
        <p className="text-xs text-muted-foreground">Legacy label: {legacyCaller} (unverified)</p>
      )}
      {checked && markedAt && (
        <p className="text-xs text-muted-foreground">Recorded: {markedAt}</p>
      )}
      <p className="text-[10px] text-muted-foreground">Caller identity and call completion are not verified.</p>
      {error && <p role="alert" className="text-xs text-red-600">{error}</p>}
    </div>
  );
}
