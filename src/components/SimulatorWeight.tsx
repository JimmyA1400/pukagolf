"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

import { Field, inputClass } from "@/components/admin/parts";
import { createClient } from "@/lib/supabase/client";

/**
 * What a simulator round counts for in a handicap. Site-wide, because a
 * player's handicap is one number wherever they play, so it is the platform
 * admin's to set rather than any one club's.
 */
export function SimulatorWeight() {
  const supabase = useMemo(() => createClient(), []);
  const [value, setValue] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(async () => {
    const { data } = await supabase.rpc("site_settings");
    const weight = (data as { simulatorWeight?: number } | null)?.simulatorWeight ?? 0.25;
    setValue(String(Math.round(weight * 100)));
  }, [supabase]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  if (value === null) return <p className="font-mono text-xs text-ink-soft">Loading…</p>;

  return (
    <form
      noValidate
      onSubmit={async (e) => {
        e.preventDefault();
        const n = Number(value);
        if (value.trim() === "" || !Number.isInteger(n) || n < 0 || n > 100) {
          return setNotice({ ok: false, text: "What a simulator round counts for runs from 0 to 100." });
        }
        setBusy(true);
        const { error } = await supabase.rpc("owner_set_simulator_weight", { in_weight: n / 100 });
        setBusy(false);
        setNotice(error ? { ok: false, text: error.message } : { ok: true, text: "Saved for every club." });
      }}
      className="space-y-3 border border-hairline bg-card p-4"
    >
      <Field
        label="A simulator round counts for (%)"
        hint="A sim score is real, but it rolls perfectly. At 25 a round four shots better than a player's outdoor form moves their index one shot; 100 counts it in full, 0 leaves it out. A house rule — WHS has no such thing."
      >
        <input inputMode="numeric" value={value} onChange={(e) => setValue(e.target.value)} className={inputClass} />
      </Field>
      {notice && (
        <p role={notice.ok ? "status" : "alert"} className={`font-mono text-xs ${notice.ok ? "text-forest" : "text-clay"}`}>
          {notice.text}
        </p>
      )}
      <button
        type="submit"
        disabled={busy}
        className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-50"
      >
        {busy ? "Saving…" : "Save"}
      </button>
    </form>
  );
}
