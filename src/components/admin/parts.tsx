"use client";

import { useState } from "react";

/**
 * The pieces every admin page is built from: a section with its heading, a
 * labelled field, a small badge, and a button that asks before doing
 * something that can't be undone. Shared so the owner's page, a club's admin
 * page and the platform page read as one.
 */

export function ConfirmButton({
  label,
  confirmLabel,
  warning,
  disabled = false,
  onConfirm,
}: {
  label: string;
  confirmLabel: string;
  warning: string;
  disabled?: boolean;
  onConfirm: () => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  if (!open) {
    return (
      <button
        type="button"
        disabled={disabled}
        onClick={() => setOpen(true)}
        className="font-mono text-xs text-clay underline disabled:cursor-not-allowed disabled:text-ink-soft disabled:no-underline disabled:opacity-60"
      >
        {label}
      </button>
    );
  }

  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className="font-mono text-xs text-clay">{warning}</span>
      <button
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          await onConfirm();
          setBusy(false);
          setOpen(false);
        }}
        // Filled, so the step that can't be taken back doesn't look like Cancel.
        className="min-h-9 bg-clay px-3 font-mono text-xs font-bold text-cream disabled:opacity-40"
      >
        {busy ? "Working…" : confirmLabel}
      </button>
      <button
        type="button"
        onClick={() => setOpen(false)}
        className="min-h-9 border border-hairline px-3 font-mono text-xs text-ink-soft"
      >
        Cancel
      </button>
    </span>
  );
}


export function Badge({
  children,
  tone,
}: {
  children: React.ReactNode;
  tone?: "forest";
}) {
  return (
    <span
      className={`ml-2 border px-1.5 py-0.5 align-middle font-mono text-[0.65rem] font-normal tracking-wider uppercase ${
        tone === "forest"
          ? "border-forest text-forest"
          : "border-hairline text-ink-soft"
      }`}
    >
      {children}
    </span>
  );
}


export function Section({
  title,
  aside,
  children,
}: {
  title: string;
  aside?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="section-head mb-3 flex items-baseline justify-between pb-2">
        <h2 className="text-xl">{title}</h2>
        {aside && <span className="meta">{aside}</span>}
      </div>
      {children}
    </section>
  );
}

export const inputClass =
  "min-h-11 w-full border border-hairline bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest";

export function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
      {hint && <span className="mt-1 block font-mono text-[0.7rem] text-ink-soft">{hint}</span>}
    </label>
  );
}
