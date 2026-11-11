# Decisions log

Answers to the open questions in the spec sections, recorded as they're made so
the schema has one place to be checked against.

| # | Question | Decision | Date |
|---|----------|----------|------|
| — | Deliverable | Real codebase: Next.js + Supabase, installable as a PWA | 2026-09-06 |
| Q1 | Dropout repair | **Auto re-close** — reseed the ring over the survivors, preserving relative order | 2026-09-06 |
| Q2 | Groups of 1 | **Refused at creation.** Minimum group size is 2. | 2026-09-06 |
| Q3 | Out-of-order rule | **Sequential INSERT, free correction.** No gaps; an already-entered hole can be edited any time. | 2026-09-06 |
| Q4 | Holes per round | 9 or 18, defaulting to 18 | 2026-09-06 |
| Q5 | Scoring basis | **Gross only.** No handicaps, no net. | 2026-09-06 |
| Q6 | Format | **Stroke play only.** | 2026-09-06 |
| Q8 | Accounts | **Players self-sign-up.** Profile row created by trigger; `is_admin` false, first admin promoted by hand. | 2026-09-06 |
| Q10 | Par data | **Per course, entered once**, prefilled with a standard par-72 layout. Rounds reference a course. | 2026-09-06 |
| Q11 | Live display | Score to par as **+3 / E / -2**, updating hole by hole. | 2026-09-06 |
| Q12 | Tee times | Admin schedules. Players may **request a window and name preferred partners**; advisory only. | 2026-09-06 |

## What these lock in

**Q5 + Q6 together** are why `scores` stays keyed by a single `player_id`. A
team format would have made a score belong to a group rather than a person, and
handicaps would have split every score into gross and net.

**Q10 resolves a conflict in the brief.** "No to par" arrived alongside a
request for +/-/E, and +/-/E *is* score to par — it cannot be computed from
stroke totals. The objection was read as being to the per-round setup burden,
so par lives on the course and is entered once: `seed_standard_pars()` fills a
standard layout, leaving the admin to adjust the holes that differ. If par data
is genuinely unwanted, `buildLeaderboard` still works without it and the UI
falls back to raw strokes — but the +/-/E display goes away with it.

**Q11 does not change who may enter a score.** "Players updating as they go"
is read as *the assigned scorer entering each hole during play* rather than at
the turn — the rotation in Q1/Q2 and the `may_score()` policy are unchanged, and
nobody enters their own card. Flag this if the intent was different, because it
would reverse the central rule of the spec.

**Q12** is `tee_time_requests`. Nothing in it writes to `tee_times`; it is
input to the admin's scheduling, not a booking. Players see only their own
request, the admin sees all of them.

| Q9 | Money on results | **Yes — skins with carries.** Outright low score takes the pot; a tie carries the stake to the next hole. | 2026-09-06 |
| Q13 | Visual design | Clubhouse look: cream/sand ground, forest green, clay red, slab serif display over monospace metadata. | 2026-09-06 |

**Q9 is implemented in `src/lib/skins.ts`** and tested. A hole settles only once
every player in the game has a score on it; until then its pot is unresolved and
shown as in progress. Because money now rides on the result, score locking and
edit auditing matter more than they did — `entered_by` already covers who typed
what, but nothing yet freezes a card once the group finishes.

## Still open

- **Q7** Single round, or multi-round with a cumulative leaderboard? The design
  shows "Season skins: $340" and "RD 14" in the header, which both need
  season-level aggregation. Left out of the page rather than faked.
- **Q14** Course conditions — needs a weather source. Currently a static
  placeholder.
- **Q15** Clubhouse feed — needs a table, and rules for what generates an entry,
  who may post, and how long it lives. Currently static placeholder text.
- **Q16** Shot-level detail. The design's "Hole 12 · Fairway · 168yd to pin"
  can't come from hole scores; it needs per-shot tracking, which is a much
  larger feature. The card shows the hole number, which is derivable, and takes
  an optional `lie` string for when there's something to put there.
- **Q17** Score locking. With skins live, can a card still be corrected after
  the group signs off?
