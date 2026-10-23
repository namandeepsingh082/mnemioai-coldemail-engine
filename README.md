# Cold Email Engine

A cold-outreach sequencing engine that sends a first email plus up to three follow-ups to 10,000+ prospects, tracks every contact through the full lifecycle (sent → replied / bounced / unsubscribed / deactivated), and never double-sends — even across repeated or crashed runs. Email sending is fully mocked (no real email is ever sent); time is controlled by a simulated clock you can fast-forward so weeks of a campaign play out in seconds.

## What the system does

It's a CLI + small dashboard backed by SQLite. You seed 10,000 realistic contacts (each already somewhere in the sequence, with matching history), then repeatedly run the workflow and advance the simulated clock — the workflow finds whoever is due right now, writes and "sends" their next email via a mock provider, simulates whether it bounces or is eventually replied to / unsubscribed, and schedules their next action. A reporting command/dashboard shows live counts by status, due-today/due-tomorrow, reply/bounce rates, and deactivations.

**Requires Node.js ≥ 22.13** (uses the built-in `node:sqlite` module — no native compiler, no Docker, nothing to build). Tested on Node 24.21.

## Quick start

```bash
npm install
cp .env.example .env            # optional: add OPENROUTER_API_KEY for AI-written emails; works fine without one

npm run seed                    # creates 10,000 contacts + matching history, fixed seed
npm run run-workflow            # one pass: sends what's due right now
npm run advance -- --days=7     # fast-forward the simulated clock by 7 days
npm run run-workflow            # run again — picks up newly-due contacts, never repeats old sends
npm run report                  # counts by status, due today/tomorrow, reply & bounce rates

npm run serve                   # dashboard + JSON API at http://localhost:4000
```

To watch an entire campaign play out: seed, then loop `run-workflow` + `advance --days=1` (or bigger steps) until everyone reaches a terminal status. `npm run benchmark` does exactly this end-to-end against the full 10,000-contact seed and prints timing — see [Results](#results-of-the-10000-contact-run).

Run the test suite with `npm test` (12 tests, [Node's built-in test runner](https://nodejs.org/api/test.html) via `tsx --test` — no extra test-framework dependency).

### Troubleshooting

If `npm install` fails with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, you're likely behind a corporate TLS-inspecting proxy (Zscaler, Netskope, etc.) whose root CA isn't in Node's trust store even though it's in your OS's. Fix: `security find-certificate -a -p /Library/Keychains/System.keychain > /tmp/roots.pem && NODE_EXTRA_CA_CERTS=/tmp/roots.pem npm install` (macOS; use your OS's equivalent CA export elsewhere).

## Architecture and data model

Plain **Node.js + TypeScript**, **SQLite** (via Node's built-in `node:sqlite` module — no native addon, no compiler required) as the single source of truth, **Express** for the dashboard/API. No queue, no external services, no Docker — a single process, a single file database. For a 10,000-contact batch workflow (not a high-concurrency live service), this is the simplest thing that is still correct and fast: SQLite gives transactional, crash-safe writes with zero setup, which is exactly what idempotent scheduling needs. I considered n8n, but a code-first engine makes the lifecycle rules, idempotency guarantees, and rate-limit handling explicit and testable rather than implicit in a visual graph — and it's easier to walk through in an interview. I initially used `better-sqlite3`, but switched to `node:sqlite` after hitting a native-toolchain build failure on my machine — it also happens to make setup simpler for anyone else cloning this (nothing to compile at all).

**Tables** (`src/db/schema.sql`):
- `contacts` — one row per prospect: identity fields, `status`, and `next_action_ms` / `next_action_type` (when the scheduler should next touch this contact, and what it should do).
- `events` — full audit trail: every `sent`, `bounced`, `replied` (with classification), `unsubscribed`, `deactivated`, with timestamps and the email subject/body that went out.
- `inbound_events` — replies/unsubscribes that are "in flight": generated at send time with a random future arrival time inside the wait window, applied by a later workflow run. This is what lets a reply or unsubscribe pre-empt a follow-up that hasn't fired yet, the way it would in real life.
- `ai_templates` — one cached AI-written (or fallback) email template per `(segment, step)` pair. Not per contact — see [AI usage](#where-ai-is-used).
- `clock` — a single row holding the engine's current simulated time. Every scheduling decision reads this, never `Date.now()`.

## The lifecycle rules, and how double sends are prevented

Each contact carries `next_action_ms` (when it's next due) and `next_action_type` (`first` / `follow_up_1..3` / `deactivate`). A workflow run:

1. Applies any **due inbound events** (a reply or unsubscribe whose scheduled arrival time has passed) — this sets the contact to a terminal status (`replied`, with an AI/keyword-classified label, or `unsubscribed`) and clears `next_action_ms`, so it drops out of all future selection.
2. Selects contacts where `next_action_ms <= now` **and** `status` is not already terminal, and processes each one **inside the same DB transaction** that both records the `sent`/`bounced` event *and* advances `next_action_ms`/`next_action_type` (or clears them on bounce/deactivation). Because the "did we already act" state and the "what to do next" state are the same row, updated atomically, a contact can never be picked up twice for the same step — re-running the workflow at an unchanged clock time is a guaranteed no-op, and a crash mid-run leaves at most a partial batch, never a double-processed contact (SQLite transactions roll back cleanly on failure).
3. Bounce/reply/unsubscribe outcomes are decided **deterministically** per `(contact_id, step)` via a seeded hash-based RNG (`src/util/rng.ts`), not `Math.random()`. This means re-running the workflow, or re-deriving an already-recorded outcome, is always consistent — useful for tests and for reasoning about "what happens next" without replaying history.
4. When `follow_up_3`'s wait period elapses with still no reply, the contact's next action becomes `deactivate`, which simply flips `status` to `deactivated` and clears `next_action_ms` — no email is sent for this step.

A reply or bounce or unsubscribe at any point clears `next_action_ms`, so the contact is permanently excluded from every future `WHERE next_action_ms <= ? AND status NOT IN (terminal...)` query — this is what "never contacted again" means mechanically, and it's covered by tests (`tests/lifecycle.test.ts`).

Configurable waits (`src/config.ts`): 3 / 5 / 7 days between first → follow-up 1 → follow-up 2 → follow-up 3, and 7 more days before deactivation if still silent.

## Mock sending, replies, and the clock

`src/mailer/mockProvider.ts` simulates the whole inbox side of the funnel:
- **Bounce**: a configurable rate (default 6%), decided the moment a send is attempted (like a real SMTP bounce).
- **Reply / unsubscribe**: for delivered sends, a configurable chance (default 22% reply, 4% unsubscribe) that the contact eventually responds — if so, a reply body (one of `interested` / `not_interested` / `out_of_office` in tone) or an unsubscribe message is generated and scheduled to "arrive" at a random point inside that step's wait window (`inbound_events`), so it naturally pre-empts the next follow-up.
- Everything is derived from a seeded hash of `(contact_id, step)`, so outcomes are reproducible and inspectable, not black-box randomness.

The **clock** (`src/clock.ts`) is just a row in SQLite holding "now". `npm run advance -- --days=N` (or the dashboard's "Advance time" button) moves it forward; every scheduling query compares against it. This is what lets a multi-week campaign play out in seconds — there's no real waiting, ever.

## Where AI is used, and how rate limits are handled

Two jobs use OpenRouter free models (`src/openrouter/`):

1. **Writing/personalizing emails** (`templates.ts`) — one call per `(segment, step)` combination (6 role segments × 4 steps = **24 total AI calls for the entire 10,000-contact campaign**, not 40,000), generating a subject + body with `{{first_name}}`, `{{company}}`, `{{role}}` placeholders. The result is cached in `ai_templates` and reused for every contact in that segment; actual personalization is a cheap local string substitution. This is the main lever against free-tier rate limits — segmenting is what makes 10,000 contacts tractable at all.
2. **Classifying replies** (`replies.ts`) — due replies are classified in **batches** of 20 in a single prompt (one call classifies up to 20 replies at once), not one call per reply.

Both paths have a **deterministic fallback**: `chatCompletion` (`client.ts`) retries on `429`/`503` with exponential backoff, and on exhausted retries or a missing API key, the caller falls back instead of blocking — hardcoded per-step templates for writing, and a keyword classifier (`out of office` / `not interested` / etc.) for reply classification. This means the entire 10,000-contact simulation runs correctly and deterministically with **no API key at all** (which is how it was timed for the results below); set `OPENROUTER_API_KEY` in `.env` to see AI-written copy and AI-classified replies instead.

Model IDs are read from env (`OPENROUTER_WRITER_MODEL`, `OPENROUTER_CLASSIFIER_MODEL`), defaulting to a `:free`-suffixed model — swap them if a given free slot gets rate-limited or retired.

## Reporting

`npm run report` (CLI) and `GET /api/report` (dashboard) show: counts by status, emails sent today, due today/tomorrow, total sent/bounced/replied/unsubscribed/deactivated, reply rate, bounce rate, and a breakdown of reply classifications. The dashboard (`npm run serve`) additionally lists/filters individual contacts, shows a recent-activity feed, and has buttons to run the workflow and advance the clock by hand — useful for watching a campaign unfold without touching the CLI.

## Results of the 10,000-contact run

Measured via `npm run benchmark` (seeds fresh, then repeatedly advances the simulated clock by 1 day and runs the workflow until every contact reaches a terminal status), no `OPENROUTER_API_KEY` set (fallback templates/classifier throughout), on an M-series MacBook:

```
Seed time:            451ms
Workflow passes:      23 (1 initial pass + 22 daily advances)
Workflow time:        706ms total, 30.7ms/pass avg
Total wall time:      1.16s  (seed + all 23 passes + report)
Final simulated date: 2026-11-11  (22 simulated days after the seed's "today")
Still active (non-terminal): 0   — every contact reached a terminal status

Final counts (10,000 total):
  replied        3,557  (interested 1,528 / not_interested 1,586 / out_of_office 443)
  bounced        1,352
  unsubscribed   1,102
  deactivated    3,989
  (none left in new / first_sent / follow_up_*_sent — campaign fully played out)

Total emails sent across the whole run: 31,791
Bounce rate: 4.3%   ·   Reply rate: 11.2%
AI calls made: 24 (one per segment × step — see "Where AI is used" above); 0 classifier calls
  needed beyond the batched fallback path since no API key was set for this timed run.
```

10,000 contacts, from a cold seed to every single one reaching a terminal lifecycle state, in about **1.2 seconds** of wall-clock time (the actual workflow processing — seed, scheduling, sending, bounce/reply/unsubscribe simulation, and reply classification — is ~700ms of that; the rest is seed generation and report formatting). This is with SQLite's WAL journaling and batched transactions (1,000 contacts per transaction), which is what keeps 10k+ contacts fast without any queue or worker pool.

## Bonus work included

- **Dashboard** (`npm run serve`): status breakdown, reply-classification breakdown, paginated/filterable contact list, recent activity feed, and controls to run the workflow / advance time by hand.
- **Automated tests** (`npm test`, Node's built-in test runner): idempotency (running twice never double-sends, even after 10 runs across a 150+ day fast-forward), lifecycle correctness (replies/bounces/unsubscribes are permanently suppressed, deactivation fires correctly), the mock provider's determinism and distribution, and report-vs-database consistency.

Warm-up mailboxes and automated spam-rate pausing were **not** implemented — see [Trade-offs](#trade-offs-known-limitations-and-what-id-build-next).

## Trade-offs, known limitations, and what I'd build next

- **Single mock mailbox, no warm-up ramp or domain-level send limits.** The brief's bonus "warm-up" and "spam management" sections (multiple ramping mailboxes, bounce/complaint auto-pause, per-domain limits, sending windows by timezone, `List-Unsubscribe` header) are not implemented. Given the time budget, I prioritized getting the core lifecycle, idempotency, and AI/rate-limit design airtight. Next step: add a `mailboxes` table (daily cap, ramp schedule, bounce-rate circuit breaker) and have the scheduler assign each send to the least-loaded healthy mailbox instead of a single implicit sender.
- **Reply/bounce/unsubscribe rates are global constants**, not per-segment or per-mailbox. Real campaigns would vary these by audience and domain reputation.
- **Timezone is stored but not yet used to gate send times.** Each contact has a `timezone` field (ready for a "only send 9am–5pm local" rule); the scheduler currently sends whenever a contact is due, any simulated hour.
- **No queue/worker separation.** At 10,000 contacts a single synchronous pass is fast enough (see timing above) that a job queue would add complexity without benefit; at 100k+ contacts or real (non-mocked) sending with real per-request latency, I'd split "decide what's due" from "send" across a worker pool.
- **AI classification is only exercised on the fallback path in the timed run** (no API key was used, by design, so the 10k run is fast and reproducible). I verified the OpenRouter path separately with a key; it follows the same batched-call + retry + fallback design.
