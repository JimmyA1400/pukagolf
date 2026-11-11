"use client";

import { useCallback, useMemo, useState } from "react";

import { createClient } from "@/lib/supabase/client";

type AuditEntry = {
  id: number;
  at: string;
  actor: string;
  action: string;
  entity: string;
  entityId: string;
  detail: Record<string, unknown> | null;
};

type SiteError = {
  id: number;
  at: string;
  kind: "error" | "rejection" | "boundary";
  message: string;
  stack: string | null;
  path: string | null;
  userAgent: string | null;
  digest: string | null;
  who: string | null;
};

const PAGE = 50;

/**
 * The audit log and the site's error log, for the owner.
 *
 * Both load when opened rather than with the page: the audit log records
 * every score edit, so it is by far the largest thing /admin could fetch.
 */
export function OwnerLogs() {
  return (
    <>
      <AuditLog />
      <SiteErrors />
    </>
  );
}

function AuditLog() {
  const supabase = useMemo(() => createClient(), []);
  const [entries, setEntries] = useState<AuditEntry[] | null>(null);
  const [more, setMore] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (before: string | null) => {
      setBusy(true);
      const { data, error: failed } = await supabase.rpc("owner_audit_log", {
        in_limit: PAGE,
        in_before: before,
      });
      setBusy(false);

      if (failed) {
        setError(failed.message);
        return;
      }

      const page = (data ?? []) as unknown as AuditEntry[];
      setEntries((current) => (before ? [...(current ?? []), ...page] : page));
      setMore(page.length === PAGE);
    },
    [supabase],
  );

  return (
    <Collapsible
      title="Audit log"
      aside="Every delete, clear, PIN change and score edit"
      onOpen={() => {
        if (entries === null) void load(null);
      }}
    >
      {error && <p className="font-mono text-xs text-clay">{error}</p>}

      {entries === null ? (
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      ) : entries.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">Nothing recorded yet.</p>
      ) : (
        <ul className="border border-hairline bg-card px-4">
          {entries.map((entry) => (
            <li
              key={entry.id}
              className="border-b border-dashed border-hairline py-2 last:border-b-0"
            >
              <p className="font-mono text-xs text-ink-soft">
                {when(entry.at)} · {entry.actor}
              </p>
              <p className="font-display text-[0.95rem]">
                {entry.action} {entry.entity.replaceAll("_", " ")}
                {summary(entry.detail) && (
                  <span className="ml-2 font-mono text-xs break-words text-ink-soft">
                    {summary(entry.detail)}
                  </span>
                )}
              </p>
            </li>
          ))}
        </ul>
      )}

      {entries && more && (
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(entries[entries.length - 1]?.at ?? null)}
          className="mt-3 font-mono text-xs text-forest underline disabled:opacity-40"
        >
          {busy ? "Loading…" : "Load older"}
        </button>
      )}
    </Collapsible>
  );
}

function SiteErrors() {
  const supabase = useMemo(() => createClient(), []);
  const [errors, setErrors] = useState<SiteError[] | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("owner_client_errors", {
      in_limit: PAGE,
    });

    if (error) {
      setNotice(error.message);
      return;
    }

    setErrors((data ?? []) as unknown as SiteError[]);
  }, [supabase]);

  const clear = async () => {
    const { error } = await supabase.rpc("owner_clear_client_errors");
    setConfirming(false);

    if (error) {
      setNotice(error.message);
      return;
    }

    setNotice(null);
    await load();
  };

  return (
    <Collapsible
      title="Site errors"
      aside="What broke in players' browsers"
      onOpen={() => {
        if (errors === null) void load();
      }}
    >
      {notice && <p className="font-mono text-xs text-clay">{notice}</p>}

      {errors === null ? (
        <p className="font-mono text-xs text-ink-soft">Loading…</p>
      ) : errors.length === 0 ? (
        <p className="font-mono text-xs text-ink-soft">
          No errors recorded. Good.
        </p>
      ) : (
        <>
          <ul className="border border-hairline bg-card px-4">
            {errors.map((error) => (
              <li
                key={error.id}
                className="border-b border-dashed border-hairline py-2 last:border-b-0"
              >
                <p className="font-mono text-xs text-ink-soft">
                  {when(error.at)} · {error.who ?? "visitor"} ·{" "}
                  {error.path ?? "unknown page"} · {error.kind}
                </p>
                <p className="font-mono text-sm break-words">{error.message}</p>
                {error.stack && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-mono text-xs text-ink-soft">
                      Stack
                    </summary>
                    <pre className="mt-1 overflow-x-auto bg-cream p-2 font-mono text-[0.7rem] leading-snug">
                      {error.stack}
                    </pre>
                  </details>
                )}
              </li>
            ))}
          </ul>

          <div className="mt-3">
            {confirming ? (
              <span className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={() => void clear()}
                  className="font-mono text-xs font-bold text-clay underline"
                >
                  Clear all {errors.length}
                </button>
                <button
                  type="button"
                  onClick={() => setConfirming(false)}
                  className="font-mono text-xs text-ink-soft underline"
                >
                  Keep them
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => setConfirming(true)}
                className="font-mono text-xs text-clay underline"
              >
                Clear the list
              </button>
            )}
          </div>
        </>
      )}
    </Collapsible>
  );
}

function Collapsible({
  title,
  aside,
  onOpen,
  children,
}: {
  title: string;
  aside: string;
  onOpen: () => void;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);

  return (
    <section>
      <div className="section-head mb-3 flex flex-wrap items-baseline justify-between gap-2 pb-2">
        <h2 className="text-xl">{title}</h2>
        <button
          type="button"
          aria-expanded={open}
          onClick={() => {
            if (!open) onOpen();
            setOpen(!open);
          }}
          className="font-mono text-xs text-forest underline"
        >
          {open ? "Hide" : "Show"}
        </button>
      </div>
      {open ? children : <p className="meta">{aside}</p>}
    </section>
  );
}

/** "Sep 11, 1:58 PM" in the viewer's own time zone. */
function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** The detail object as short key: value pairs, for a one-line entry. */
function summary(detail: Record<string, unknown> | null): string {
  if (!detail) return "";

  return Object.entries(detail)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) =>
      `${key.replaceAll("_", " ")}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    )
    .join(" · ")
    .slice(0, 200);
}
