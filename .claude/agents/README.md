# Tester agents

Two agent definitions drive the browser tests from a player's and a club
professional's point of view. Their system prompts are kept outside the
repository, in `private/agents/` (gitignored).

The machinery they use is public and is the interesting part:

- `scripts/testers/session.mjs` — signs an agent in through the real form,
  refuses to run against anything but the test database, and writes
  screenshots to `.tester-runs/<who>/`.
- `scripts/test-db/make-testers.py` — builds the test club and its logins.
- `e2e/` — the Playwright suites the agents' findings were turned into.

To run the agents yourself, drop a Claude Code subagent definition at
`.claude/agents/<name>.md`; `session.mjs` is the only interface it needs.
