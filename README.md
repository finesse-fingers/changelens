# Changelens

**A local web app for reviewing diffs that an AI agent wrote.** It drives the
[Claude Code](https://claude.com/claude-code) CLI you already have installed and
answers the question a large agent-written diff makes hard: **what am I actually
accepting?**

Point it at a git repository or a pull request. It groups the diff by *change*
rather than by file, puts a plain-language judgement beside each change instead
of in a panel you have to look away to read, and tells you which agent session
wrote what. Nothing leaves your machine except through your own `claude` and
`gh`.

It was built for a workflow where several coding agents run in parallel across
many worktrees, so by the time a PR exists there is no memory of which session
produced what, or why. It works just as well on one agent, or on a colleague's
PR.

---

## Prerequisites

| | Why | Check |
|---|---|---|
| **Node ≥ 22.13** | `node:sqlite` is unflagged from 22.13. Earlier 22.x crashes on startup. | `node -v` |
| **pnpm** | The lockfile and every script assume it. | `pnpm -v` |
| **git ≥ 2.31** | `rev-parse --path-format`, used to identify worktrees. | `git --version` |
| **Claude Code, logged in** | Every job runs through it. There is no API-key path — Changelens has no key of its own. | `claude --version`, then `pnpm check:auth` |
| **GitHub CLI, logged in** | Only for the pull-request half: PR lists, PR diffs, posting comments. Local-branch review works without it. | `gh auth status` |

`pnpm check:auth` runs one small, budget-capped `claude` call with
`ANTHROPIC_API_KEY` deleted from the environment — so if it succeeds, your
logged-in CLI is genuinely what is being used.

Developed on macOS; Linux should work. Windows is untested.

## Install and run

```bash
git clone https://github.com/finesse-fingers/changelens.git
cd changelens
pnpm install
pnpm dev          # API on :4317, UI on :4316
```

Open <http://localhost:4316>.

For a production build, `pnpm build && pnpm start` serves the built UI from the
API port and opens a browser.

**First screen empty?** The repository list is built from your Claude Code and
Codex session history, so it is empty until you have used one of them — and it
will also be empty if they ran somewhere this machine cannot see, such as a
container, a devcontainer, or a remote host. Paste a repository path into the
box instead; that always works.

## What it costs

Changelens does not charge anything, but **the four jobs spend real money on
your Anthropic account**, because each one runs `claude`. Spend is capped per
run as a runaway guard, not as a budget: roughly $0.75 per annotated file
(scaled up for more expensive models) and $12 for a review. Exploring a
snapshot, reading a diff and marking work reviewed are all free — nothing calls
a model until you press one of the four buttons.

## What it reads from your machine

Worth knowing before you run it, because it is more than the repository you
point it at:

- **Every Claude Code and Codex session transcript in your home directory**
  (`~/.claude/projects`, `~/.codex/sessions`), to discover recent repositories
  and to attribute each changed file to the session that wrote it. That includes
  transcripts from repositories unrelated to the one under review. It is read
  locally; only the file under review is ever sent to `claude`.
- **The repository you select**, including uncommitted work.

It writes `~/.changelens/db.sqlite` (review state) and, when you review someone
else's PR, isolated checkouts under `~/.changelens/worktrees/`. Those are real
git worktrees and nothing currently cleans them up. See [SECURITY.md](SECURITY.md).

## Configuration

All optional.

| Variable | Default | Effect |
|---|---|---|
| `CHANGELENS_PORT` | `4317` | API port. The dev proxy follows it. |
| `CHANGELENS_CLAUDE_BIN` | `claude` | Full path to the CLI, if it is not on `PATH`. |
| `CHANGELENS_OPEN` | — | Set to `0` to stop `pnpm start` opening a browser. |
| `CHANGELENS_REVIEW_BUDGET_USD` | `12` | Spend cap for one *Find bugs* run. |
| `CHANGELENS_NARRATE_BUDGET_USD` | `0.75` | Spend cap per annotated file, before model scaling. |
| `CHANGELENS_NARRATE_MODEL` | `sonnet` | Default model for *Annotate changes*. |

Nothing loads a `.env` file — set these in your shell.

---

## What it does

**Target picker.** Discovers repos from your Claude and Codex session history
(collapsing the many worktrees of one repo to that repo), then resolves a
target into an auditable snapshot: base, head, how the base was derived, dirty
digest, and what is in scope. Nothing runs until you have seen that.

**Review console.** One scrolling column of code with an annotation margin, so
every explanation sits beside the change it describes rather than in a panel
you have to look away to read:
- the diff, syntax-highlighted and grouped by *change* rather than by file, each
  group headed by what it is and what grouped it
- a margin note per change: what it does, a 1–5 quality score, the findings
  anchored there, and its accept control
- a provenance chip on each file naming the session that wrote it
- the four-section brief as a lead card at the top of the stream, and the run's
  recipe and caveats in a strip under the top bar

Grouping is deterministic on load — shared names, shared symbols, rename pairs
and which agent session wrote what — so the stream is organised before anything
is spent. `Explain this change` replaces those groups with the map's cards,
carrying `Requested|Supporting|Extra` scope, `Planned|Changed|Verified|Blocked`
state and a risk tier. The top bar switches between `change`, `card`, `session`
and `file` groupings; none is imposed.

**Annotations judge, they do not just describe.** Each change is rated
`major | minor | routine` and scored 1–5 on three axes — **conventions** (the
repo's own `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md`, nearest file winning,
with the rule quoted and its path named), **clarity**, and **design**. Only axes
with something real to say appear; an axis rated "ok" is omitted rather than
padded. Routine changes collapse to one dim line, so the margin carries signal
rather than volume — the top bar switches between `all`, `notable` and
`problems`. A convention citation naming a file the repo does not have is
dropped before it reaches you: one invented citation costs every real one its
credibility. When a repo documents no conventions, the top bar says so instead
of scoring an axis against nothing.

Keys: `j`/`k` move, `n` next unreviewed, `space` accept and advance, `u` undo,
`x` flag, `f` next untriaged finding, `l` the findings ledger, `g` jump,
`b` collapse the brief, `t` theme, `?` the full list.

**The ledger** (`l`, or click the findings counter) is where findings get
worked rather than read. Pinning them in the margin is right for reading a
diff and wrong for clearing a list — on a sixty-unit PR the fifteenth finding
is four screens away. The ledger puts all of them in one place, in reported
rank order and never re-sorted, with six dispositions on each row
(`fix`, `reply-only`, `already-addressed`, `reject`, `defer`, `blocked`), lenses
to filter by call, batch posting to the PR, and a markdown export for a handoff.
The export carries the base and head SHAs, because a triage decision only means
anything against the comparison it was made on.

**Four jobs, all driving your local `claude`:**

| | what it gives you |
|---|---|
| Explain this change | the brief, change cards, and the caveats worth your attention |
| Annotate changes | a scored, cited judgement beside each change, one shard per file, four at a time (model and effort chosen in the top bar, separately from the review's) |
| Find bugs | `/code-review` findings, streamed in and anchored to lines |
| Apply fix | one finding applied to the working tree, never committed |

**Resume.** Review state is keyed to content, not position. Come back after an
agent has pushed and the banner says what moved and what is still reviewed —
never that it reset.

**Write-back.** Posting PR comments and applying fixes each show the exact
payload first. Authority at one gate never implies the next.

## Decisions worth knowing

**Review units are `-U0` change-runs, not `-U3` hunks.** A `-U3` hunk's
boundaries depend on its neighbours, so an edit four lines away merges two
hunks, the old hash vanishes, and work you already reviewed resets. Splitting
each hunk into maximal change-runs shrinks that window to zero.
`src/server/git/units.test.ts` proves the case.

**Noise is three tiers, not a boolean.** `excluded` never reaches a model;
`digest` still shows, because a generated types file gaining 43 lines usually
means a database column moved — dropping it silently would be a reviewer bug,
not a saving.

**Every CLI flag is verified by observed effect.** The CLI accepts unknown
flags silently and exits 0, so a flag that does nothing is indistinguishable
from one that works. `src/server/runner/capability.ts` probes `--json-schema`
and `--max-budget-usd` for real. Two things this caught:
- `--output-format stream-json` requires `--verbose` under `--print`
- `--add-dir` and `--allowedTools` are variadic and swallow a trailing prompt,
  so the prompt goes over stdin

**Blank output is INCOMPLETE, never clean.** A map or review that produced
nothing is reported as failed rather than as a change with no findings.

**Base resolution.** Everything is compared against a true fork point, never a
branch tip. A PR uses `merge-base(baseRefOid, head)` — the commit GitHub's own
"Files changed" compares against — and a local branch uses a merge-base against
a discovered base ref. `main` is never assumed.

Diffing a PR against `baseRefOid` directly is the trap: that OID is the base
branch's *tip*, so for an open PR it moves forward as the branch advances and a
two-dot diff reports everything that landed since the fork as if this PR had
deleted it. On one PR seven commits behind its base, that was the difference
between 87 files with four thousand deletions and the 7 files with 36 that
GitHub showed.

## The one that bites headless

`/code-review`'s fan-out recipes dispatch their angle agents with
`run_in_background`, then end the turn to wait for task notifications.
Interactively the notification wakes the session back up. Under `--print` there
is no next turn — the process exits, the angles finish into a dead session, and
the review reports nothing while looking like a clean exit. Observed across
three runs on the same diff: the two that dispatched in the background produced
zero findings, the one that ran its agents in the foreground produced five.

The review job therefore sets `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (verified
by observed effect in the capability probe, not assumed), says so again in an
appended system prompt, and — if a turn still ends without a report — resumes
the session once to ask for it rather than discarding the work.

## Known gaps

Product:

- Review sharding: a large diff reviewed in one `/code-review` call is capped at
  4–15 findings by recipe, so on a very large PR the result is a sample rather
  than coverage. Sharding by risk tier is the natural next step.
- Findings are held in memory per snapshot; the schema has a `finding` table
  but runs are not yet replayed from it across restarts.
- Codex provenance recovers paths from `apply_patch` envelopes, so attribution
  is best-effort compared with Claude's structured tool calls, and is wrong for
  an agent that ran from a subdirectory of a monorepo.
- The conventions chain is re-sent with every narrate shard (one `claude`
  process per file), so a large guide is re-read on every file of a wide diff.
  It is capped at 24k characters, nearest file first.
- Per-shard spend is capped as a runaway guard, scaled by model. That scaling is
  load-bearing rather than tidy: a cap set from a sonnet measurement and applied
  unscaled to a 5×-priced model aborts every shard mid-analysis with no
  structured output, so the run is billed in full and nothing is annotated.
- `src/server/jobs/recipes.ts` describes `/code-review`'s routing as observed in
  one specific CLI build. On another build those labels may be wrong, and it
  invents a plausible fallback rather than admitting ignorance.

Engineering:

- No tests for the web UI, and none for `gh/writeback.ts` or `jobs/fix.ts` — the
  two paths that write to a PR and to your working tree.
- The database handle is a module-level singleton, so tests that open different
  paths silently share the first one.
- `gh/writeback.ts` bypasses the classified `gh()` helper: no timeout, no error
  classification, so a hung call hangs the request.
- The capability probe is never invoked by the UI, and no job consults its
  result.
- No schema migrations — the schema is created if missing and never altered.
- No linter or formatter.

## Development

```bash
pnpm typecheck
pnpm test        # 79 tests, offline, no credentials needed
pnpm build
```

Tests cover diff parsing and line-number fidelity, `-z` numstat (a repo with
emoji filenames is enough to make git's octal-escaped form unparseable), noise
classification, unit identity and cross-snapshot matching, base resolution,
clustering, the disposition ledger, and argv construction.

See [CONTRIBUTING.md](CONTRIBUTING.md) and [AGENTS.md](AGENTS.md).

## Licence

[MIT](LICENSE) © Bobby Koteski
