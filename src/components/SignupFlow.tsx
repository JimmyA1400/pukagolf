"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { PlayerDetailsForm } from "@/components/PlayerDetailsForm";
import { RsvpControl } from "@/components/RsvpControl";
import { authMessage } from "@/lib/auth-message";
import { nextFromLocation } from "@/lib/next-path";
import { formatUsPhone, toE164 } from "@/lib/phone";
import { createClient, isConfigured } from "@/lib/supabase/client";
import { useCooldown } from "@/lib/useCooldown";
import { usePlayer } from "@/lib/usePlayer";

/**
 * Two stages, because the second needs a session the first creates.
 *
 * Account first (name, mobile number, password, then the texted code), and the
 * golf details after. No session exists until the number is confirmed, so the
 * details form cannot be reached before then.
 */
export function SignupFlow() {
  const router = useRouter();
  const { state, saveDetails, setRsvp, reload } = usePlayer();

  if (!isConfigured) {
    return (
      <Shell>
        <p className="font-mono text-sm text-ink-soft">
          Not connected to a database yet.
        </p>
      </Shell>
    );
  }

  if (state.status === "loading") {
    return (
      <Shell>
        <p className="font-mono text-sm text-ink-soft">Loading…</p>
      </Shell>
    );
  }

  if (state.status === "signed-out") {
    return <CreateAccount onCreated={reload} />;
  }

  const { profile, rounds } = state;
  const teeTimes = [...new Set(rounds.flatMap((r) => r.teeTimes))].sort();

  return (
    <Shell>
      <div>
        <p className="meta">Step 2 of 2</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Your details
        </h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          Signed in as {profile.full_name}.
        </p>
      </div>

      <PlayerDetailsForm
        initial={{
          fullName: profile.full_name,
          phone: profile.phone,
          handicapIndex: profile.handicap_index,
          preferredTeeTime: profile.preferred_tee_time,
          preferredTee: profile.preferred_tee,
        }}
        teeTimes={teeTimes}
        submitLabel="Save and finish"
        onSubmit={async (details) => {
          const refusal = await saveDetails(details);
          if (refusal) return refusal;

          // Back to the club they came to join, if they came from one.
          router.push(nextFromLocation("/profile"));
          return null;
        }}
      />

      {rounds.length > 0 && (
        <section>
          <h2 className="section-head mb-3 pb-2 text-xl">Upcoming rounds</h2>
          <p className="mb-3 font-mono text-xs text-ink-soft">
            Let the organiser know if you&apos;re playing. You can change this
            later from your profile.
          </p>

          <div className="space-y-3">
            {rounds.map((round) => (
              <div
                key={round.id}
                className="border border-hairline bg-card px-4 py-3"
              >
                <p className="font-display text-base font-bold">{round.name}</p>
                <p className="mb-2 font-mono text-xs text-ink-soft">
                  {round.played_on}
                </p>
                <RsvpControl
                  value={round.myStatus}
                  lockedAt={round.rsvp_lock_at}
                  onChange={(status) => void setRsvp(round.id, status)}
                />
              </div>
            ))}
          </div>
        </section>
      )}
    </Shell>
  );
}

/**
 * Create the account, then confirm the number by text.
 *
 * Phone rather than email: everyone in the league already has everyone else's
 * number, and an emailed confirmation link is a step people lose. The code is
 * what proves the number is real, so nothing counts as signed up until it is
 * entered.
 */
function CreateAccount({ onCreated }: { onCreated: () => void }) {
  const [next, setNext] = useState("/");
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setNext(nextFromLocation("/")), []);
  const [stage, setStage] = useState<"details" | "verify">("details");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);
  const cooldown = useCooldown();
  const [errors, setErrors] = useState<Record<string, string>>({});

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const found: Record<string, string> = {};
    if (name.trim().split(/\s+/).filter(Boolean).length < 2) {
      found.name = "Enter your first and last name.";
    }
    const e164 = toE164(phone);
    if (!e164) {
      found.phone = "Enter a 10-digit US mobile number.";
    }
    // Supabase's own floor is 6; saying so up front beats a server round trip.
    if (password.length < 8) {
      found.password = "Use at least 8 characters.";
    }

    setErrors(found);
    if (!e164 || Object.keys(found).length > 0) return;

    setBusy(true);
    const supabase = createClient();
    const { error } = await supabase.auth.signUp({
      phone: e164,
      password,
      options: { data: { full_name: name.trim() } },
    });
    setBusy(false);

    if (error) {
      console.error(error);
      setMessage(authMessage(error));
      return;
    }

    const {
      data: { session },
    } = await supabase.auth.getSession();

    // A project with phone confirmation switched off hands back a session
    // straight away, and there is no code to ask for.
    if (session) {
      onCreated();
      return;
    }

    setSent(e164);
    cooldown.start();
    setStage("verify");
  };

  const verify = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const digits = code.replace(/\D/g, "");
    if (digits.length < 6 || sent === null) {
      setErrors({ code: "Enter the 6-digit code from the text." });
      return;
    }

    setErrors({});
    setBusy(true);
    const { error } = await createClient().auth.verifyOtp({
      phone: sent,
      token: digits,
      type: "sms",
    });
    setBusy(false);

    if (error) {
      console.error(error);
      setMessage(authMessage(error));
      return;
    }

    onCreated();
  };

  const resend = async () => {
    if (sent === null) return;

    setMessage(null);
    setBusy(true);
    const { error } = await createClient().auth.resend({
      type: "sms",
      phone: sent,
    });
    setBusy(false);
    if (error) console.error(error);
    else cooldown.start();
    setMessage(error ? authMessage(error) : "Sent another code.");
  };

  if (stage === "verify") {
    return (
      <Shell>
        <div>
          <p className="meta">Step 1 of 2</p>
          <h1 className="font-display text-3xl font-bold tracking-tight">
            Confirm your number
          </h1>
          <p className="mt-1 font-mono text-xs text-ink-soft">
            We texted a code to {phone}.
          </p>
        </div>

        <form onSubmit={verify} noValidate className="space-y-4">
          <Field label="Code" error={errors.code}>
            <input
              value={code}
              onChange={(e) => setCode(e.target.value)}
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              placeholder="123456"
              className={`${inputClass(errors.code)} tracking-[0.4em]`}
            />
          </Field>

          {message && (
            <p
              role="alert"
              className="border border-clay bg-card px-3 py-2 font-mono text-xs break-words text-clay"
            >
              {message}
            </p>
          )}

          <button
            type="submit"
            disabled={busy}
            className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
          >
            {busy ? "Checking…" : "Confirm"}
          </button>
        </form>

        <div className="flex gap-4">
          <button
            type="button"
            onClick={() => void resend()}
            disabled={busy || cooldown.left > 0}
            className="font-mono text-xs text-ink-soft underline disabled:opacity-40"
          >
            {cooldown.left > 0 ? `Send another code in ${cooldown.left}s` : "Send another code"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStage("details");
              setMessage(null);
            }}
            className="font-mono text-xs text-ink-soft underline"
          >
            Wrong number?
          </button>
        </div>
      </Shell>
    );
  }

  return (
    <Shell>
      <div>
        <p className="meta">Step 1 of 2</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">
          Join the league
        </h1>
      </div>

      {/*
        noValidate: the browser's own validation blocks submit before this
        component's handler runs. The player then gets a native tooltip on one
        field instead of inline messages on every field that is wrong.
      */}
      <form onSubmit={submit} noValidate className="space-y-4">
        <Field label="Name" error={errors.name}>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoComplete="name"
            placeholder="First and last"
            className={inputClass(errors.name)}
          />
        </Field>

        <Field label="Mobile number" error={errors.phone}>
          <input
            value={phone}
            onChange={(e) => setPhone(formatUsPhone(e.target.value))}
            inputMode="tel"
            autoComplete="tel"
            placeholder="(239) 555-0132"
            className={inputClass(errors.phone)}
          />
        </Field>

        <Field label="Password" error={errors.password}>
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="new-password"
            className={inputClass(errors.password)}
          />
        </Field>

        {message && (
          <p
            role="alert"
            className="border border-clay bg-card px-3 py-2 font-mono text-xs break-words text-clay"
          >
            {message}
          </p>
        )}

        <button
          type="submit"
          disabled={busy}
          className="min-h-14 w-full bg-forest-deep px-4 font-mono text-sm tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Creating…" : "Create account"}
        </button>

        <p className="font-mono text-xs text-ink-soft">
          We text a code to confirm the number. Standard rates apply.
        </p>
      </form>

      <Link
        href={next === "/" ? "/sign-in" : `/sign-in?next=${encodeURIComponent(next)}`}
        className="font-mono text-xs text-ink-soft underline"
      >
        Already have an account? Sign in
      </Link>
    </Shell>
  );
}

function inputClass(error?: string): string {
  return `min-h-12 w-full border bg-cream px-3 font-mono text-sm focus:outline-2 focus:outline-forest ${
    error ? "border-clay" : "border-hairline"
  }`;
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="block">
      <span className="meta mb-1 block">{label}</span>
      {children}
      {error && (
        <span role="alert" className="mt-1 block font-mono text-xs text-clay">
          {error}
        </span>
      )}
    </label>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md space-y-8 p-6 sm:p-8">
      <h2 className="font-display text-lg font-bold tracking-tight">
        Puka<span className="text-forest">Golf</span>
      </h2>
      {children}
    </main>
  );
}
