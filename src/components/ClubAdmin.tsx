"use client";

import { useRouter } from "next/navigation";
import QRCode from "qrcode";
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge, ConfirmButton, Field, inputClass, Section } from "@/components/admin/parts";
import { DetailsEditor, HandicapEditor } from "@/components/LeagueAdmin";
import { clubPath, type ClubRole } from "@/lib/club-paths";
import { useClub } from "@/lib/club";
import { formatHandicapIndex } from "@/lib/handicap-index";
import { formatUsPhone } from "@/lib/phone";
import { createClient } from "@/lib/supabase/client";

/** One member or request, from club_admin_overview(). */
type Member = {
  id: string;
  name: string;
  phone: string | null;
  handicapIndex: number | null;
  isGuest: boolean;
  role: ClubRole;
  status: "active" | "requested";
  staffCanFixScores: boolean;
  requestedAt: string;
};

type League = {
  id: string;
  slug: string;
  name: string;
  status: "active" | "archived";
  playing: string[];
  asking: string[];
};

type Overview = { leagues: League[]; members: Member[] };

type State =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Overview };

type Notice = { tone: "ok" | "error"; text: string };

const NO_ACCOUNT = "Nobody has signed up with that number yet. Send them the club's link so they can.";

const ROLE_LABEL: Record<ClubRole, string> = {
  admin: "Admin",
  staff: "Staff",
  player: "Player",
};

/**
 * A club's admin page: who is in the club, as what, and in which league, and
 * the link and QR code people join by.
 *
 * Every button is one database function that checks, again, that the caller
 * runs this club; the page only decides what to draw.
 */
export function ClubAdmin() {
  const { club, reloadClub } = useClub();
  const router = useRouter();
  const supabase = useMemo(() => createClient(), []);
  const [state, setState] = useState<State>({ status: "loading" });
  const [notice, setNotice] = useState<Notice | null>(null);

  // A confirmation goes after a few seconds; a refusal stays to be read.
  useEffect(() => {
    if (notice?.tone !== "ok") return;
    const timer = setTimeout(() => setNotice(null), 6000);
    return () => clearTimeout(timer);
  }, [notice]);

  const load = useCallback(async () => {
    const { data, error } = await supabase.rpc("club_admin_overview", { in_club_id: club.id });

    if (error) {
      setState({ status: "error", message: error.message });
      return;
    }

    setState({ status: "ready", data: data as unknown as Overview });
  }, [supabase, club.id]);

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  /** Run one action, say how it went, and reload what the page shows. */
  const run = useCallback(
    async (
      action: () => PromiseLike<{ error: { message: string; hint?: string } | null }>,
      done: string,
    ) => {
      setNotice(null);
      const { error } = await action();

      // Nothing went wrong and nothing changed: said plainly, not as a refusal.
      if (error?.hint === "already_member") {
        setNotice({ tone: "ok", text: error.message });
        return true;
      }

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
    return <p className="font-mono text-sm text-ink-soft">Loading the club…</p>;
  }

  if (state.status === "error") {
    return <p className="font-mono text-sm text-clay">{state.message}</p>;
  }

  const { members, leagues } = state.data;
  const requests = members.filter((m) => m.status === "requested");
  const active = members.filter((m) => m.status === "active");
  const nameOf = new Map(members.map((m) => [m.id, m.name]));

  return (
    <div className="space-y-10">
      {notice && (
        <p
          role={notice.tone === "error" ? "alert" : "status"}
          // Pinned to the bottom of the screen: the change was made far down
          // the page, and a "Saved" at the top of it went unseen.
          className={`fixed inset-x-4 bottom-4 z-30 mx-auto max-w-xl border bg-card px-4 py-3 font-mono text-xs break-words shadow-md ${
            notice.tone === "error" ? "border-clay text-clay" : "border-forest text-forest"
          }`}
        >
          {notice.text}
        </p>
      )}

      <Section title="Join link" aside="for new members">
        <JoinShare slug={club.slug} name={club.name} />
      </Section>

      <Section
        title="Asking to join"
        aside={requests.length ? `${requests.length} waiting` : "none waiting"}
      >
        {requests.length === 0 ? (
          <p className="font-mono text-xs text-ink-soft">
            Nobody is waiting. New requests show here when someone uses the join link.
          </p>
        ) : (
          <ul>
            {requests.map((m) => (
              <li
                key={m.id}
                className="flex flex-wrap items-baseline justify-between gap-2 border-b border-dashed border-hairline py-3 last:border-b-0"
              >
                <span>
                  <span className="font-display text-base font-bold">{m.name}</span>
                  <span className="ml-2 font-mono text-xs text-ink-soft">
                    {m.phone ? formatUsPhone(m.phone.replace(/^\+1/, "")) : "no number"}
                  </span>
                </span>
                <span className="flex gap-4">
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => supabase.rpc("club_decide", { in_club_id: club.id, in_profile_id: m.id, in_approve: true }),
                        `${m.name} is a member now.`,
                      )
                    }
                    className="font-mono text-xs text-forest underline"
                  >
                    Approve
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      void run(
                        () => supabase.rpc("club_decide", { in_club_id: club.id, in_profile_id: m.id, in_approve: false }),
                        `Declined ${m.name}.`,
                      )
                    }
                    className="font-mono text-xs text-clay underline"
                  >
                    Decline
                  </button>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Members" aside={`${active.length} in the club`}>
        <AddMember
          onAdd={(phone, role) =>
            run(
              async () => {
                const added = await supabase.rpc("club_add_member", { in_club_id: club.id, in_phone: phone, in_role: role });
                // Since 0055 a number with no account comes back empty rather
                // than as an error, so the lookup still counts against the
                // admin's hourly ration.
                if (!added.error && added.data === null) {
                  return { error: { message: NO_ACCOUNT } };
                }
                return added;
              },
              "Added to the club.",
            )
          }
        />

        <ul className="mt-4">
          {active.map((m) => (
            <MemberRow
              key={m.id}
              member={m}
              onRole={(role) =>
                run(
                  () => supabase.rpc("club_set_role", { in_club_id: club.id, in_profile_id: m.id, in_role: role }),
                  `${m.name} is ${ROLE_LABEL[role].toLowerCase()} now.`,
                )
              }
              onStaffScores={(allowed) =>
                run(
                  () =>
                    supabase.rpc("club_set_staff_scores", {
                      in_club_id: club.id,
                      in_profile_id: m.id,
                      in_allowed: allowed,
                    }),
                  allowed ? `${m.name} can fix scores.` : `${m.name} can't fix scores now.`,
                )
              }
              onRemove={() =>
                run(
                  () => supabase.rpc("club_remove_member", { in_club_id: club.id, in_profile_id: m.id }),
                  `${m.name} is no longer in the club.`,
                )
              }
              onHandicap={(index) =>
                run(
                  () => supabase.rpc("owner_set_handicap", { in_profile_id: m.id, in_index: index }),
                  index === null ? `Cleared ${m.name}'s handicap.` : `${m.name}'s handicap is set.`,
                )
              }
              onDetails={(name, phone) =>
                run(
                  () =>
                    supabase.rpc("owner_update_player", {
                      in_profile_id: m.id,
                      in_full_name: name,
                      in_phone: phone,
                    }),
                  `Saved ${name}.`,
                )
              }
            />
          ))}
        </ul>
      </Section>

      <Section title="Leagues" aside={`${leagues.length} in the club`}>
        <NewLeague
          onCreate={async (name) => {
            let created: string | null = null;
            const ok = await run(async () => {
              const result = await supabase.rpc("league_create", { in_club_id: club.id, in_name: name });
              created = (result.data as string | null) ?? null;
              return result;
            }, `Started ${name}.`);

            // The league picker learns about it, and this page moves to it.
            if (ok && created) {
              const fresh = (await reloadClub()).find((c) => c.id === club.id);
              const league = fresh?.leagues.find((l) => l.id === created);
              if (fresh && league) router.push(clubPath(fresh.slug, "/admin", league, fresh.leagues));
            }
            return ok;
          }}
        />

        <div className="mt-4 space-y-6">
          {leagues.map((league) => (
            <LeagueBlock
              key={league.id}
              league={league}
              members={active}
              nameOf={nameOf}
              onSet={(profileId, playing, who) =>
                run(
                  () =>
                    supabase.rpc("league_set_member", {
                      in_league_id: league.id,
                      in_profile_id: profileId,
                      in_playing: playing,
                    }),
                  playing ? `${who} plays in ${league.name} now.` : `${who} is out of ${league.name}.`,
                )
              }
            />
          ))}
        </div>
      </Section>
    </div>
  );
}

/** The club's join link and its QR code, for the counter or a poster. */
function JoinShare({ slug, name }: { slug: string; name: string }) {
  const [qr, setQr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // From the live address, so it is right on the preview, on live, and on a
  // club's own domain alike.
  const [url] = useState(() =>
    typeof window === "undefined" ? "" : `${window.location.origin}/join/${slug}`,
  );

  useEffect(() => {
    if (!url) return;
    void QRCode.toDataURL(url, { margin: 1, width: 512 }).then(setQr);
  }, [url]);

  return (
    <div className="flex flex-wrap items-start gap-5">
      {qr && (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={qr}
          alt={`QR code for joining ${name}`}
          className="w-40 border border-hairline bg-card p-2"
        />
      )}
      <div className="min-w-0 flex-1 space-y-3">
        <p className="font-mono text-xs text-ink-soft">
          Anyone with this link can ask to join. You approve each request below.
        </p>
        <p className="break-all border border-hairline bg-card px-3 py-2 font-mono text-xs">{url}</p>
        <button
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(url);
              setCopied(true);
            } catch {
              setCopied(false);
            }
          }}
          className="font-mono text-xs text-forest underline"
        >
          {copied ? "Copied" : "Copy the link"}
        </button>
      </div>
    </div>
  );
}

function AddMember({ onAdd }: { onAdd: (phone: string, role: ClubRole) => Promise<boolean> }) {
  const [phone, setPhone] = useState("");
  const [role, setRole] = useState<ClubRole>("player");
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const ok = await onAdd(phone, role);
        setBusy(false);
        if (ok) setPhone("");
      }}
      className="grid gap-3 border border-hairline bg-card p-4 sm:grid-cols-[1fr_auto_auto] sm:items-end"
    >
      <Field label="Add by phone number" hint="They need an account already. If not, send them the join link.">
        <input
          type="tel"
          inputMode="tel"
          value={phone}
          onChange={(e) => setPhone(formatUsPhone(e.target.value))}
          placeholder="(555) 555-0100"
          className={inputClass}
        />
      </Field>
      <Field label="As">
        <select value={role} onChange={(e) => setRole(e.target.value as ClubRole)} className={inputClass}>
          <option value="player">Player</option>
          <option value="staff">Staff</option>
          <option value="admin">Admin</option>
        </select>
      </Field>
      <button
        type="submit"
        disabled={busy || phone.replace(/\D/g, "").length < 10}
        className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-50"
      >
        {busy ? "Adding…" : "Add"}
      </button>
    </form>
  );
}

function MemberRow({
  member,
  onRole,
  onStaffScores,
  onRemove,
  onHandicap,
  onDetails,
}: {
  member: Member;
  onRole: (role: ClubRole) => Promise<boolean>;
  onStaffScores: (allowed: boolean) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
  onHandicap: (index: number | null) => Promise<boolean>;
  onDetails: (name: string, phone: string | null) => Promise<boolean>;
}) {
  // Making someone an admin, or taking it away, waits for a yes: an admin
  // can do almost anything in the club.
  const [pendingRole, setPendingRole] = useState<ClubRole | null>(null);

  const chooseRole = (role: ClubRole) => {
    if (role === member.role) return;
    if (role === "admin" || member.role === "admin") setPendingRole(role);
    else void onRole(role);
  };

  return (
    <li className="border-b border-dashed border-hairline py-3 last:border-b-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="font-display text-base font-bold">
          {member.name}
          {member.role !== "player" && <Badge tone="forest">{ROLE_LABEL[member.role]}</Badge>}
          {member.isGuest && <Badge>Guest</Badge>}
        </span>
        <span className="font-mono text-xs text-ink-soft">
          {member.phone ? formatUsPhone(member.phone.replace(/^\+1/, "")) : "no number"}
          {member.handicapIndex !== null && ` · HCP ${formatHandicapIndex(member.handicapIndex)}`}
        </span>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-x-5 gap-y-2">
        <HandicapEditor current={member.handicapIndex} onSave={onHandicap} />
        {/* A name and number belong to the person in every club; the database
            refuses a change here for someone also in a club you don't run. */}
        <DetailsEditor player={{ name: member.name, contact: member.phone }} onSave={onDetails} />

        {!member.isGuest && (
          <label className="flex items-center gap-2 font-mono text-xs">
            <span className="text-ink-soft">Role</span>
            <select
              value={pendingRole ?? member.role}
              onChange={(e) => chooseRole(e.target.value as ClubRole)}
              className="min-h-9 border border-hairline bg-cream px-2 font-mono text-xs"
            >
              <option value="player">Player</option>
              <option value="staff">Staff</option>
              <option value="admin">Admin</option>
            </select>
          </label>
        )}

        {pendingRole && (
          <span role="alert" className="flex flex-wrap items-center gap-3 font-mono text-xs">
            <span className="text-clay">
              {pendingRole === "admin"
                ? `Make ${member.name} an admin? They'll be able to run the whole club: members, leagues, weeks and scores.`
                : `Take admin away from ${member.name}? They'll be ${ROLE_LABEL[pendingRole].toLowerCase()} from now on.`}
            </span>
            <button
              type="button"
              onClick={async () => {
                const role = pendingRole;
                setPendingRole(null);
                await onRole(role);
              }}
              className="font-bold text-clay underline"
            >
              {pendingRole === "admin" ? "Make admin" : "Change it"}
            </button>
            <button
              type="button"
              onClick={() => setPendingRole(null)}
              className="text-ink-soft underline"
            >
              Cancel
            </button>
          </span>
        )}

        {member.role === "staff" && (
          <label className="flex items-center gap-2 font-mono text-xs">
            <input
              type="checkbox"
              checked={member.staffCanFixScores}
              onChange={(e) => void onStaffScores(e.target.checked)}
            />
            Can fix scores
          </label>
        )}

        <ConfirmButton
          label="Remove from club"
          confirmLabel="Remove"
          warning={`${member.name} leaves the club and its leagues. Their account and scores stay.`}
          onConfirm={onRemove}
        />
      </div>
    </li>
  );
}

function NewLeague({ onCreate }: { onCreate: (name: string) => Promise<boolean> }) {
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  return (
    <form
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const ok = await onCreate(name.trim());
        setBusy(false);
        if (ok) setName("");
      }}
      className="grid gap-3 border border-hairline bg-card p-4 sm:grid-cols-[1fr_auto] sm:items-end"
    >
      <Field label="Start a league" hint="It starts as a standard league: singles, stroke play, gross.">
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Wednesday Nights"
          maxLength={80}
          className={inputClass}
        />
      </Field>
      <button
        type="submit"
        disabled={busy || name.trim().length < 2}
        className="min-h-11 bg-forest-deep px-4 font-mono text-xs tracking-wider text-cream uppercase disabled:opacity-50"
      >
        {busy ? "Starting…" : "Start"}
      </button>
    </form>
  );
}

/**
 * One league: who plays in it, who has asked to, and a way to put any member
 * in. The pro shop places players; asking only puts a name in front of them.
 */
function LeagueBlock({
  league,
  members,
  nameOf,
  onSet,
}: {
  league: League;
  members: Member[];
  nameOf: Map<string, string>;
  onSet: (profileId: string, playing: boolean, who: string) => Promise<boolean>;
}) {
  const [adding, setAdding] = useState("");
  const playing = new Set(league.playing);
  const notPlaying = members.filter((m) => !playing.has(m.id));

  return (
    <div className="border border-hairline bg-card p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-display text-lg font-bold">{league.name}</h3>
        <span className="meta">
          {league.playing.length} {league.playing.length === 1 ? "player" : "players"}
        </span>
      </div>

      {league.asking.length > 0 && (
        <div className="mt-3">
          <p className="meta mb-1">Asking to play</p>
          <ul className="space-y-1">
            {league.asking.map((id) => (
              <li key={id} className="flex flex-wrap items-baseline justify-between gap-2 font-mono text-xs">
                <span>{nameOf.get(id) ?? "A member"}</span>
                <button
                  type="button"
                  onClick={() => void onSet(id, true, nameOf.get(id) ?? "They")}
                  className="text-forest underline"
                >
                  Put them in
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      <ul className="mt-3 flex flex-wrap gap-2">
        {league.playing.map((id) => (
          <li key={id} className="flex items-center gap-2 border border-hairline px-2 py-1 font-mono text-xs">
            {nameOf.get(id) ?? "Not a member now"}
            <button
              type="button"
              aria-label={`Take ${nameOf.get(id) ?? "them"} out of ${league.name}`}
              onClick={() => void onSet(id, false, nameOf.get(id) ?? "They")}
              className="text-clay"
            >
              ×
            </button>
          </li>
        ))}
        {league.playing.length === 0 && (
          <li className="font-mono text-xs text-ink-soft">Nobody plays in it yet.</li>
        )}
      </ul>

      {notPlaying.length > 0 && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <label className="sr-only" htmlFor={`add-${league.id}`}>
            Add a member to {league.name}
          </label>
          <select
            id={`add-${league.id}`}
            value={adding}
            onChange={(e) => setAdding(e.target.value)}
            className="min-h-9 border border-hairline bg-cream px-2 font-mono text-xs"
          >
            <option value="">Add a member…</option>
            {notPlaying.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!adding}
            onClick={async () => {
              const ok = await onSet(adding, true, nameOf.get(adding) ?? "They");
              if (ok) setAdding("");
            }}
            className="font-mono text-xs text-forest underline disabled:text-ink-soft disabled:no-underline"
          >
            Add
          </button>
        </div>
      )}
    </div>
  );
}
