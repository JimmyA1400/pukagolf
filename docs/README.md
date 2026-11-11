# docs

The design and security write-ups for this project are kept outside the
repository, in `private/docs/` (gitignored), because they describe the live
deployment's defences in enough detail to be a map for someone attacking it:
row-level-security posture, which privileged functions a signed-out visitor can
reach, lockout thresholds and rate-limit settings.

What is public instead:

- `spec/01-score-entry.md` — the requirements the scoring rules came from.
- `spec/decisions.md` — the design questions, answered and still open.
- Every migration in `supabase/migrations/` carries a header comment
  explaining what it protects and why, which is where the enforcement actually
  lives.
