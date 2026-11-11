"use client";

import { useState } from "react";

import {
  formatHandicapIndex,
  parseHandicapInput,
} from "@/lib/handicap-index";
import { formatUsPhone, fromE164, toE164 } from "@/lib/phone";
import { TEE_PREFERENCES } from "@/lib/tee-preference";
import { formatTimeOfDay } from "@/lib/usePlayer";

export type PlayerDetails = {
  fullName: string;
  phone: string | null;
  handicapIndex: number | null;
  preferredTeeTime: string | null;
  preferredTee: string | null;
};

type Errors = Partial<Record<keyof PlayerDetails, string>>;

/**
 * The details a player gives at signup and can revise later.
 *
 * Validation here is for the messages; the same rules run again in the
 * database, because a POST straight to the API never sees this form.
 */
export function PlayerDetailsForm({
  initial,
  teeTimes,
  submitLabel,
  onSubmit,
}: {
  initial: Partial<PlayerDetails>;
  /** Slots the league actually offers, as "08:10:00". */
  teeTimes: string[];
  submitLabel: string;
  onSubmit: (details: PlayerDetails) => Promise<string | null>;
}) {
  const [fullName, setFullName] = useState(initial.fullName ?? "");
  const [phone, setPhone] = useState(fromE164(initial.phone));
  const [handicap, setHandicap] = useState(
    initial.handicapIndex !== null && initial.handicapIndex !== undefined
      ? formatHandicapIndex(initial.handicapIndex)
      : "",
  );
  const [teeTime, setTeeTime] = useState(initial.preferredTeeTime ?? "");
  const [tee, setTee] = useState(initial.preferredTee ?? "");

  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const validate = (): { details: PlayerDetails } | { errors: Errors } => {
    const found: Errors = {};

    // First AND last: a league roster of first names alone is unusable.
    const trimmed = fullName.trim();
    if (trimmed.split(/\s+/).filter(Boolean).length < 2) {
      found.fullName = "Enter your first and last name.";
    }

    const e164 = phone.trim() === "" ? null : toE164(phone);
    if (phone.trim() !== "" && e164 === null) {
      found.phone = "Enter a valid US phone number.";
    }

    let handicapIndex: number | null = null;
    if (handicap.trim() !== "") {
      const parsed = parseHandicapInput(handicap);
      if (!parsed.ok) found.handicapIndex = parsed.reason;
      else handicapIndex = parsed.value;
    }

    if (Object.keys(found).length > 0) return { errors: found };

    return {
      details: {
        fullName: trimmed,
        phone: e164,
        handicapIndex,
        preferredTeeTime: teeTime || null,
        preferredTee: tee || null,
      },
    };
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);
    setSaved(false);

    const result = validate();
    if ("errors" in result) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setBusy(true);
    const refusal = await onSubmit(result.details);
    setBusy(false);

    if (refusal) setNotice(refusal);
    else setSaved(true);
  };

  return (
    // noValidate so this component's messages show rather than native tooltips.
    <form onSubmit={submit} noValidate className="space-y-4">
      <Field label="Name" error={errors.fullName}>
        <input
          value={fullName}
          onChange={(e) => setFullName(e.target.value)}
          autoComplete="name"
          placeholder="First and last"
          className={input(errors.fullName)}
        />
      </Field>

      <Field label="Phone" error={errors.phone}>
        <input
          value={phone}
          onChange={(e) => setPhone(formatUsPhone(e.target.value))}
          inputMode="tel"
          autoComplete="tel"
          placeholder="(313) 555-0142"
          className={input(errors.phone)}
        />
      </Field>

      <Field
        label="Current Handicap Index (self-reported)"
        error={errors.handicapIndex}
        hint="Recalculated automatically once you post scores. Use a leading + for a plus handicap, e.g. +1.4."
      >
        <input
          value={handicap}
          onChange={(e) => setHandicap(e.target.value)}
          inputMode="decimal"
          placeholder="12.4"
          className={input(errors.handicapIndex)}
        />
      </Field>

      <Field label="Preferred tee time">
        <select
          value={teeTime}
          onChange={(e) => setTeeTime(e.target.value)}
          className={input()}
        >
          <option value="">No preference</option>
          {teeTimes.map((slot) => (
            <option key={slot} value={slot}>
              {formatTimeOfDay(slot)}
            </option>
          ))}
        </select>
        {teeTimes.length === 0 && (
          <p className="mt-1 font-mono text-xs text-ink-soft">
            No slots posted yet — you can set this later.
          </p>
        )}
      </Field>

      <Field
        label="Preferred tee set"
        hint="Matched to whichever set each course calls by that name."
      >
        <select
          value={tee}
          onChange={(e) => setTee(e.target.value)}
          className={input()}
        >
          <option value="">No preference</option>
          {TEE_PREFERENCES.map((option) => (
            <option key={option.id} value={option.id}>
              {option.label}
            </option>
          ))}
        </select>
      </Field>

      {notice && (
        <p
          role="alert"
          className="border border-clay bg-card px-3 py-2 font-mono text-xs text-clay"
        >
          {notice}
        </p>
      )}

      {saved && (
        <p className="font-mono text-xs text-forest">Saved.</p>
      )}

      <button
        type="submit"
        disabled={busy}
        className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
      >
        {busy ? "Saving…" : submitLabel}
      </button>
    </form>
  );
}

function input(error?: string): string {
  return `min-h-12 w-full border bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest ${
    error ? "border-clay" : "border-hairline"
  }`;
}

function Field({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
      {hint && !error && (
        <span className="mt-1 block font-mono text-xs text-ink-soft">
          {hint}
        </span>
      )}
      {error && (
        <span role="alert" className="mt-1 block font-mono text-xs text-clay">
          {error}
        </span>
      )}
    </label>
  );
}
