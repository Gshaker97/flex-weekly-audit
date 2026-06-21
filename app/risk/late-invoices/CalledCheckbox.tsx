"use client";

import { useState, useTransition } from "react";
import { setInvoiceCalled } from "./actions";

export function CalledCheckbox({
  invoiceId,
  initial,
  calledBy,
}: {
  invoiceId: string;
  initial: boolean;
  calledBy: string | null;
}) {
  const [checked, setChecked] = useState(initial);
  const [pending, start] = useTransition();

  return (
    <label className="inline-flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        disabled={pending}
        onChange={(e) => {
          const v = e.target.checked;
          setChecked(v);
          start(() => setInvoiceCalled(invoiceId, v));
        }}
        className="h-4 w-4 cursor-pointer rounded border-border accent-green-600"
      />
      {checked && calledBy && (
        <span className="text-xs text-muted-foreground">{calledBy}</span>
      )}
    </label>
  );
}
