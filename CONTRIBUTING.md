# Contributing

Thanks for looking. This is a local-first tool with a small surface, so most
changes are easy to try end to end.

## Setup

See [Prerequisites](README.md#prerequisites) first — the short version is
Node ≥ 22.13, pnpm, and git ≥ 2.31.

```bash
pnpm install
pnpm dev      # API on :4317, UI on :4316
```

You do **not** need a Claude Code login, a GitHub login, or network access to
build the project or run the tests. You need a logged-in `claude` only to
exercise the four jobs that actually call a model.

## Gates

```bash
pnpm typecheck
pnpm test        # 79 tests, offline, no credentials
pnpm build
```

CI runs all three on Node 22.13 and 24. There is no linter and no formatter —
match the surrounding style: two-space indent, single quotes, no semicolon-free
experiments. If you add one, do it as its own PR rather than mixed into a
change.

## What the tests cover, and what they don't

Pure functions are well covered: diff parsing, change-run extraction, clustering,
the disposition ledger, base resolution, argv construction. Anything with an
effect is not. In particular there are **no tests for the web UI**, and none for
`src/server/gh/writeback.ts` or `src/server/jobs/fix.ts` — the two paths that
write to a PR and to your working tree. Tests there would be welcome.

Fixtures are built at runtime with `mkdtempSync`, so there is nothing to check
in and nothing to fetch.

## House rules worth knowing

Three of these are load-bearing, and a change that breaks one will look fine:

- **Blank output is incomplete, never clean.** A job that produced nothing must
  report itself failed. "No findings" and "the run died" must never render the
  same.
- **Every CLI flag is verified by observed effect.** The `claude` CLI accepts
  unknown flags silently and exits 0, so a flag that does nothing is
  indistinguishable from one that works. See `src/server/runner/capability.ts`.
- **Authority gates are separate and never inferred.** Permission to inspect is
  not permission to fix; permission to fix is not permission to publish.

Comments here explain *why*, not *what* — and several encode a measurement or a
bug that is not obvious from the code. Please keep that style: if you change the
behaviour a comment justifies, update the reasoning with it.

## Reporting things

Bugs and ideas: <https://github.com/finesse-fingers/changelens/issues>.
For anything security-shaped, see [SECURITY.md](SECURITY.md).
