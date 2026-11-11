# SCORE ENTRY — captured spec + design notes

Status: spec section 1 of N. Implementation deliberately deferred until the
remaining sections land, so the schema is designed once.

Target stack (decided): Next.js + Supabase (Postgres, RLS, realtime).

---

## 1. Requirements as given

R1. Admin manually creates tee times and assigns players to groups
    (foursomes or smaller). No auto-matching, no player-facing signup.
R2. Scoring rotates within a group: in a group of N, player[i] scores
    player[(i+1) % N]. Must be generic in N, not hardcoded to 4.
R3. A logged-in player may submit scores only for the single player they
    are assigned to score — never themselves, never anyone else.
R4. Every player can VIEW their own live score and the full leaderboard.
R5. Score submissions propagate live to all viewers, no refresh.
R6. Admin can: edit any score; reassign who scores whom mid-round;
    create and edit tee times and pairings.
R7. Validation: a hole score cannot be submitted out of order for the
    player being scored.

---

## 2. Design consequences

### 2.1 Rotation is a generator, not the source of truth

R2 gives the *default* assignment; R6 says the admin can reassign mid-round.
So the ring cannot be computed on read — it must be materialized as rows the
admin can mutate:

    scorer_assignments(round_id, scorer_player_id, scored_player_id, ...)

`ring(players) -> [(p[i], p[(i+1) % n]) for i in 0..n-1]` becomes a seeding
function run at group creation, plus a "re-close the ring" repair action.
Generic in N by construction.

### 2.2 Dropouts break the ring — the repair needs a defined behavior

This is the main thing R6's "someone drops out, no signal" implies, and it
isn't specified yet.

Foursome P1->P2->P3->P4->P1. P2 drops. Two edges die: P1 has nobody to
score, and P3 has nobody scoring them. Options:

  (a) Auto re-close: reseed the ring over remaining players
      -> P1->P3->P4->P1. One click, stays generic in N.
  (b) Minimal patch: splice out the dropped node, P1->P3, leave the rest.
      (Same result as (a) for a single dropout; they diverge after two.)
  (c) Manual: admin picks the new scorer explicitly.

Recommendation: (a) as a one-click default with (c) always available.
Needs your call — it changes whether reassignment is one action or two.

### 2.3 Group of 1 is degenerate

R2's wraparound sends a solo player to themselves, which R3 forbids. A
one-player group therefore has no valid scorer. Either the admin scores
them, or groups of 1 are disallowed at creation. Needs your call.
(N=2 is fine: P1<->P2 mutual.)

### 2.4 "Out of order" needs one clarification

R7 blocks creating a gap: hole N is submittable only if holes 1..N-1 exist
for that player. But it should almost certainly NOT block *correcting* an
already-entered hole — a scorer who fat-fingers hole 3 while on hole 7
needs to fix it.

Proposed reading: sequential INSERT, free UPDATE of existing holes.
Confirm this is what you meant.

### 2.5 Enforcement lives in RLS, not the client

R3 is a security rule, not a UI rule — the client's "you can only see one
scorecard" must be backed by a database policy, or anyone with the API key
can post any score.

  scores INSERT/UPDATE: permitted iff auth.uid() is the *currently assigned*
    scorer for (round_id, scored_player_id). Self-scoring blocked
    independently, so a bad assignment can't open a self-scoring hole.
  scores SELECT: any player in the round reads all scores (R4 leaderboard).
  admin: bypass on all of the above (R6).

### 2.6 Audit trail

Because assignments change mid-round (R6) and the admin can overwrite
scores, each score row should carry `entered_by` + `updated_at` separate
from `scored_player_id`. Without it, "who put a 9 on my card" is
unanswerable after a reassignment.

### 2.7 Live sync

Supabase realtime subscription on `scores`, filtered by round_id. Satisfies
R5 for both the leaderboard and a player's own card. Optimistic local
update on submit, reconciled against the broadcast.

---

## 3. Open questions for the remaining spec

These affect the schema, so they're worth answering before code:

  Q1. Dropout repair behavior — 2.2 (a), (b), or (c)?
  Q2. Groups of 1 — allowed with an admin-scores exception, or disallowed?
  Q3. Sequential insert but free correction — 2.4, confirm?
  Q4. Holes per round: always 18, or 9/18 configurable?
  Q5. Gross only, or handicaps/net? (Changes leaderboard + score columns.)
  Q6. Format: stroke play only, or also match/stableford/scramble?
      A team format would mean scores don't belong to a single player.
  Q7. One round per event, or multi-round tournaments with a cumulative
      leaderboard?
  Q8. How do players get accounts — admin invites, or self-signup?
  Q9. Anything ride on the results (skins, payouts, side bets)? That would
      raise the bar on score locking/verification.

Q5, Q6 and Q7 are the ones most likely to reshape the core tables, which is
why I'm holding.
