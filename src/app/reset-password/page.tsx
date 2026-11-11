"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

import { authMessage } from "@/lib/auth-message";
import { formatUsPhone, toE164 } from "@/lib/phone";
import { createClient, isConfigured } from "@/lib/supabase/client";
import { useCooldown } from "@/lib/useCooldown";

type Stage = "phone" | "code" | "password";

/**
 * Forgot password, by text.
 *
 * The texted code signs the player in — the same kind of code that confirmed
 * their number when they joined — and once signed in they choose a new
 * password. Nothing here creates an account: an unknown number is refused,
 * not signed up.
 *
 * Accounts made with an email address, before the league moved to phone
 * numbers, have no number to text, so the page says to ask the organiser.
 */
export default function ResetPassword() {
  const router = useRouter();
  const [stage, setStage] = useState<Stage>("phone");
  const [phone, setPhone] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [again, setAgain] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const cooldown = useCooldown();

  if (!isConfigured) {
    return (
      <Shell>
        <p className="font-mono text-sm text-ink-soft">Not connected to a database yet.</p>
      </Shell>
    );
  }

  const sendCode = async (to: string) => {
    setBusy(true);
    const { error } = await createClient().auth.signInWithOtp({
      phone: to,
      options: { shouldCreateUser: false },
    });
    setBusy(false);

    if (error) {
      console.error(error);
      setMessage(authMessage(error));
      return false;
    }

    cooldown.start();
    return true;
  };

  const submitPhone = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const e164 = toE164(phone);
    if (!e164) {
      setMessage("Enter a 10-digit US mobile number.");
      return;
    }

    if (await sendCode(e164)) {
      setSentTo(e164);
      setStage("code");
    }
  };

  const submitCode = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    const digits = code.replace(/\D/g, "");
    if (digits.length < 6 || sentTo === null) {
      setMessage("Enter the 6-digit code from the text.");
      return;
    }

    setBusy(true);
    const { error } = await createClient().auth.verifyOtp({
      phone: sentTo,
      token: digits,
      type: "sms",
    });
    setBusy(false);

    if (error) {
      console.error(error);
      setMessage(authMessage(error));
      return;
    }

    setStage("password");
  };

  const submitPassword = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (password.length < 8) {
      setMessage("Use at least 8 characters.");
      return;
    }
    if (password !== again) {
      setMessage("The two passwords don't match.");
      return;
    }

    setBusy(true);
    const { error } = await createClient().auth.updateUser({ password });
    setBusy(false);

    if (error) {
      console.error(error);
      setMessage(authMessage(error));
      return;
    }

    router.push("/league");
    router.refresh();
  };

  const alert = message && (
    <p
      role="alert"
      className="border border-clay bg-card px-3 py-2 font-mono text-xs break-words text-clay"
    >
      {message}
    </p>
  );

  return (
    <Shell>
      {stage === "phone" && (
        <>
          <Heading title="Forgot your password?">
            We&apos;ll text a code to the number you joined with.
          </Heading>
          <form onSubmit={submitPhone} noValidate className="space-y-3">
            <Field label="Mobile number">
              <input
                value={phone}
                onChange={(e) => setPhone(formatUsPhone(e.target.value))}
                inputMode="tel"
                autoComplete="tel"
                placeholder="(239) 555-0132"
                className={inputClass}
              />
            </Field>
            {alert}
            <Submit busy={busy} label="Text me a code" busyLabel="Sending…" />
          </form>
          <p className="font-mono text-xs text-ink-soft">
            Joined with an email address? Ask the organiser to reset it.
          </p>
        </>
      )}

      {stage === "code" && (
        <>
          <Heading title="Enter the code">We texted a code to {phone}.</Heading>
          <form onSubmit={submitCode} noValidate className="space-y-3">
            <Field label="Code">
              <input
                value={code}
                onChange={(e) => setCode(e.target.value)}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                placeholder="123456"
                className={`${inputClass} tracking-[0.4em]`}
              />
            </Field>
            {alert}
            <Submit busy={busy} label="Confirm" busyLabel="Checking…" />
          </form>
          <div className="flex gap-4">
            <button
              type="button"
              disabled={busy || cooldown.left > 0}
              onClick={async () => {
                setMessage(null);
                if (sentTo && (await sendCode(sentTo))) setMessage("Sent another code.");
              }}
              className="font-mono text-xs text-ink-soft underline disabled:opacity-40"
            >
              {cooldown.left > 0 ? `Send another code in ${cooldown.left}s` : "Send another code"}
            </button>
            <button
              type="button"
              onClick={() => {
                setStage("phone");
                setMessage(null);
              }}
              className="font-mono text-xs text-ink-soft underline"
            >
              Wrong number?
            </button>
          </div>
        </>
      )}

      {stage === "password" && (
        <>
          <Heading title="Choose a new password">You&apos;re signed in. Pick something you&apos;ll remember.</Heading>
          <form onSubmit={submitPassword} noValidate className="space-y-3">
            <Field label="New password">
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </Field>
            <Field label="New password again">
              <input
                type="password"
                value={again}
                onChange={(e) => setAgain(e.target.value)}
                autoComplete="new-password"
                className={inputClass}
              />
            </Field>
            {alert}
            <Submit busy={busy} label="Save new password" busyLabel="Saving…" />
          </form>
        </>
      )}

      <Link href="/sign-in" className="font-mono text-xs text-ink-soft underline">
        Back to sign in
      </Link>
    </Shell>
  );
}

const inputClass =
  "mt-1 min-h-12 w-full border border-hairline bg-card px-3 font-mono text-sm focus:outline-2 focus:outline-forest";

function Heading({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div>
      <h1 className="font-display text-3xl font-bold tracking-tight">{title}</h1>
      <p className="mt-1 font-mono text-xs text-ink-soft">{children}</p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="block">
      <span className="meta">{label}</span>
      {children}
    </label>
  );
}

function Submit({ busy, label, busyLabel }: { busy: boolean; label: string; busyLabel: string }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
    >
      {busy ? busyLabel : label}
    </button>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md space-y-6 p-6 sm:p-8">
      <p className="font-display text-lg font-bold tracking-tight">
        Puka<span className="text-forest">Golf</span>
      </p>
      {children}
    </main>
  );
}
