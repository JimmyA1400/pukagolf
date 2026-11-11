"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, ConfirmButton, Field, inputClass, Section } from "@/components/admin/parts";
import { OwnerLogs } from "@/components/OwnerLogs";
import { PlatformAccounts } from "@/components/PlatformAccounts";
import { SimulatorWeight } from "@/components/SimulatorWeight";
import { formatUsPhone } from "@/lib/phone";
import { createClient } from "@/lib/supabase/client";

type PlatformClub = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "paused" | "closed";
  isDemo: boolean;
  members: number;
  requests: number;
  leagues: number;
  admins: string[];
  lastPlayed: string | null;
};

type State =
  | { status: "loading" }
  | { status: "denied" }
  | { status: "error"; message: string }
  | { status: "ready"; clubs: PlatformClub[] };

type Notice = { tone: "ok" | "error"; text: string };

/** "Moose Ridge Golf Course" → "moose-ridge-golf-course", as a starting point. */
function slugFor(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

/**
 * Every club at a glance, and starting a new one.
 *
 * Also the things that reach across clubs: merging and deleting accounts,
 * the simulator weight every handicap uses, the audit log and the site's
 * error log.
 */
export function PlatformAdmin() {
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);

  const load = useCallback(async () => {
    const { data: allowed } = await supabase.rpc("is_platform_admin");
    if (allowed !== true) {
      setState({ status: "denied" });
      return;
    }

    const { data, error } = await supabase.rpc("platform_clubs");
    if (error) {
      setState({ status: "error", message: error.message });
      return;
    }

    setState({ status: "ready", clubs: (data as unknown as PlatformClub[]) ?? [] });
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  const run = useCallback(
    async (action: () => PromiseLike<{ error: { message: string } | null }>, done: string) => {
      setNotice(null);
      const { error } = await action();
      if (error) {
        setNotice({ tone: "error", text: error.message });
        return false;
      }
      setNotice({ tone: "ok", text: done });
      await load();
      return true;
    },
    [load],
  );

  if (state.status === "loading") {
    return <Centered>Loading the clubs…</Centered>;
  }

  if (state.status === "denied") {
    return (
      <Centered>
        <p>This page is for the platform admin.</p>
        <Link href="/league" className="mt-3 inline-block underline">
          Your clubs
        </Link>
      </Centered>
    );
  }

  if (state.status === "error") {
    return <Centered>{state.message}</Centered>;
  }

  return (
    <main className="mx-auto w-full max-w-3xl space-y-10 p-5 sm:p-8">
      <header>
        <p className="meta">Platform</p>
        <h1 className="font-display text-3xl font-bold tracking-tight">Every club</h1>
        <p className="mt-1 font-mono text-xs text-ink-soft">
          Only your account can open this page. Every change is written to the audit log.
        </p>
      </header>

      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          className={`border bg-card px-4 py-3 font-mono text-xs break-words ${
            notice.tone === "error" ? "border-clay text-clay" : "border-forest text-forest"
          }`}
        >
          {notice.text}
        </p>
      )}

      <Section title="Clubs" aside={`${state.clubs.length} in all`}>
        <ul>
          {state.clubs.map((club) => (
            <li key={club.id} className="border-b border-dashed border-hairline py-3 last:border-b-0">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <span className="font-display text-base font-bold">
                  {club.status === "closed" ? (
                    club.name
                  ) : (
                    <Link href={`/c/${club.slug}/league`} className="underline">
                      {club.name}
                    </Link>
                  )}
                  {club.isDemo && <Badge>Demo</Badge>}
                  {club.status === "closed" && <Badge>Closed</Badge>}
                </span>
                <span className="font-mono text-xs text-ink-soft">/c/{club.slug}</span>
              </div>

              <p className="mt-0.5 font-mono text-xs text-ink-soft">
                {club.members} {club.members === 1 ? "member" : "members"}
                {club.requests > 0 && ` · ${club.requests} asking to join`} · {club.leagues}{" "}
                {club.leagues === 1 ? "league" : "leagues"} · last played{" "}
                {club.lastPlayed ?? "never"}
              </p>
              <p className="mt-0.5 font-mono text-xs text-ink-soft">
                {club.admins.length ? `Admins: ${club.admins.join(", ")}` : "No admin yet"}
              </p>

              <div className="mt-2 flex flex-wrap gap-x-5 gap-y-2">
                {club.status !== "closed" && (
                  <Link href={`/c/${club.slug}/admin`} className="font-mono text-xs text-forest underline">
                    Members and leagues
                  </Link>
                )}
                {club.status === "closed" ? (
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => supabase.rpc("platform_set_club_status", { in_club_id: club.id, in_status: "active" }),
                        `${club.name} is open again.`,
                      )
                    }
                    className="font-mono text-xs text-forest underline"
                  >
                    Reopen
                  </button>
                ) : (
                  club.slug !== "pukagolf" && (
                    <ConfirmButton
                      label="Close the club"
                      confirmLabel="Close it"
                      warning={`Hides ${club.name} from its members. Nothing is deleted, and you can reopen it.`}
                      onConfirm={() =>
                        run(
                          () => supabase.rpc("platform_set_club_status", { in_club_id: club.id, in_status: "closed" }),
                          `${club.name} is closed.`,
                        )
                      }
                    />
                  )
                )}
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="Start a club">
        <NewClub
          onCreate={(slug, name, isDemo, adminPhone) =>
            run(
              () =>
                supabase.rpc("platform_create_club", {
                  in_slug: slug,
                  in_name: name,
                  in_is_demo: isDemo,
                  in_admin_phone: adminPhone || null,
                }),
              `${name} is set up at /c/${slug}.`,
            )
          }
        />
      </Section>

      <Section title="Accounts" aside="merge or delete">
        <PlatformAccounts />
      </Section>

      <Section title="Handicaps">
        <SimulatorWeight />
      </Section>

      <OwnerLogs />
    </main>
  );
}

function NewClub({
  onCreate,
}: {
  onCreate: (slug: string, name: string, isDemo: boolean, adminPhone: string) => Promise<boolean>;
}) {
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [isDemo, setIsDemo] = useState(false);
  const [adminPhone, setAdminPhone] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const ok = await onCreate(slug, name.trim(), isDemo, adminPhone);
        setBusy(false);
        if (ok) {
          setName("");
          setSlug("");
          setSlugTouched(false);
          setIsDemo(false);
          setAdminPhone("");
        }
      }}
      className="grid gap-4 border border-hairline bg-card p-4"
    >
      <Field label="Club name">
        <input
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (!slugTouched) setSlug(slugFor(e.target.value));
          }}
          placeholder="Moose Ridge Golf Course"
          maxLength={80}
          className={inputClass}
        />
      </Field>
      <Field label="Address" hint={`pukagolf.com/c/${slug || "moose-ridge"} now; ${slug || "moose-ridge"}.pukagolf.com once the domain is set up.`}>
        <input
          value={slug}
          onChange={(e) => {
            setSlugTouched(true);
            setSlug(e.target.value.toLowerCase());
          }}
          placeholder="moose-ridge"
          maxLength={40}
          className={inputClass}
        />
      </Field>
      <Field label="First admin's phone number" hint="Optional. They need an account already; you can add them later.">
        <input
          type="tel"
          inputMode="tel"
          value={adminPhone}
          onChange={(e) => setAdminPhone(formatUsPhone(e.target.value))}
          placeholder="(555) 555-0100"
          className={inputClass}
        />
      </Field>
      <label className="flex items-center gap-2 font-mono text-xs">
        <input type="checkbox" checked={isDemo} onChange={(e) => setIsDemo(e.target.checked)} />
        A demo, shown to the course before it has agreed to anything
      </label>
      <button
        type="submit"
        disabled={busy || name.trim().length < 1 || slug.length < 2}
        className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-50"
      >
        {busy ? "Setting it up…" : "Start the club"}
      </button>
    </form>
  );
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <main className="mx-auto w-full max-w-md p-8 text-center font-mono text-sm text-ink-soft">
      {children}
    </main>
  );
}
