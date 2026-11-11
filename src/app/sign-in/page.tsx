"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

import { authMessage } from "@/lib/auth-message";
import { nextFromLocation } from "@/lib/next-path";
import { formatUsPhone, toE164 } from "@/lib/phone";
import { createClient, isConfigured } from "@/lib/supabase/client";

/**
 * Sign in with a mobile number and a password.
 *
 * Signing up lives at /signup, which collects golf details as well — folding
 * that in here would put five extra fields in front of returning members every
 * time.
 *
 * The email box is kept for accounts made before the league moved to phone
 * numbers. New accounts never have an email address, so it is off to one side
 * rather than offered first.
 */
export default function SignIn() {
  const router = useRouter();
  // Where signing in came from, such as a club's join page, to go back to.
  // Read after the first render so the server's HTML and the browser's agree.
  const [next, setNext] = useState("/");
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setNext(nextFromLocation("/")), []);
  const [using, setUsing] = useState<"phone" | "email">("phone");
  const [phone, setPhone] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!isConfigured) {
    return (
      <main className="mx-auto w-full max-w-md p-8">
        <h1 className="font-display text-2xl font-bold">Not connected</h1>
        <p className="mt-3 font-mono text-sm text-ink-soft">
          Add your Supabase URL and anon key to{" "}
          <code className="bg-sand px-1">.env.local</code>, then restart the dev
          server.
        </p>
      </main>
    );
  }

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    let credential: { phone: string } | { email: string };

    if (using === "phone") {
      const e164 = toE164(phone);

      if (!e164) {
        setMessage("Enter a 10-digit US mobile number.");
        return;
      }

      credential = { phone: e164 };
    } else {
      credential = { email: email.trim() };
    }

    setBusy(true);
    const { error } = await createClient().auth.signInWithPassword({
      ...credential,
      password,
    });
    setBusy(false);

    if (error) {
      console.error(error);
      setMessage(authMessage(error));
      return;
    }

    router.push(next);
    router.refresh();
  };

  return (
    <main className="mx-auto w-full max-w-md p-6 sm:p-8">
      <h1 className="font-display text-3xl font-bold tracking-tight">
        Puka<span className="text-forest">Golf</span>
      </h1>
      <p className="meta mt-2">Sign in to score</p>

      {/*
        noValidate: type="email" triggers the browser's own validation, which
        blocks submit before this handler runs and replaces the message below
        with a native tooltip.
      */}
      <form onSubmit={submit} noValidate className="mt-6 space-y-3">
        {using === "phone" ? (
          <Field
            label="Mobile number"
            value={phone}
            onChange={(next) => setPhone(formatUsPhone(next))}
            inputMode="tel"
            autoComplete="tel"
            placeholder="(239) 555-0132"
          />
        ) : (
          <Field
            label="Email"
            type="email"
            value={email}
            onChange={setEmail}
            autoComplete="email"
          />
        )}

        <Field
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="current-password"
        />

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
          className="min-h-12 w-full bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-40"
        >
          {busy ? "Working…" : "Sign in"}
        </button>
      </form>

      <div className="mt-4 flex flex-wrap gap-4">
        <Link
          href={next === "/" ? "/signup" : `/signup?next=${encodeURIComponent(next)}`}
          className="font-mono text-xs text-ink-soft underline"
        >
          Need an account? Join the league
        </Link>

        <Link href="/reset-password" className="font-mono text-xs text-ink-soft underline">
          Forgot your password?
        </Link>

        <button
          type="button"
          onClick={() => {
            setUsing(using === "phone" ? "email" : "phone");
            setMessage(null);
          }}
          className="font-mono text-xs text-ink-soft underline"
        >
          {using === "phone"
            ? "Older account? Use your email"
            : "Use your mobile number"}
        </button>
      </div>
    </main>
  );
}

function Field({
  label,
  value,
  onChange,
  type = "text",
  inputMode,
  autoComplete,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  type?: string;
  inputMode?: "tel" | "numeric";
  autoComplete?: string;
  placeholder?: string;
}) {
  return (
    <label className="block">
      <span className="meta">{label}</span>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        inputMode={inputMode}
        autoComplete={autoComplete}
        placeholder={placeholder}
        className="mt-1 min-h-12 w-full border border-hairline bg-card px-3 font-mono text-sm focus:outline-2 focus:outline-forest"
      />
    </label>
  );
}
