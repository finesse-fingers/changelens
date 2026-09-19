# Security

## Reporting a vulnerability

Please open a [security advisory](https://github.com/finesse-fingers/changelens/security/advisories/new)
rather than a public issue. This is a personal project maintained in spare time;
expect a reply in days rather than hours.

## The threat model, stated plainly

Changelens is a local tool with **no authentication**, by design. Two things
make that a deliberate choice rather than an oversight:

- **It binds to loopback only** (`127.0.0.1`), so nothing off the machine can
  reach it.
- **It can spawn `claude` against your repositories.** Anything already running
  as your user could read those repositories and run `claude` directly anyway,
  so a token would have bought very little. Every side-effecting route requires
  a JSON body, which a browser will not send cross-origin without a preflight
  this server does not answer.

The consequence: **do not expose the port.** Do not put it behind a tunnel, a
reverse proxy, or `--host`. If you need multi-user access, that is a different
application.

## What it reads

Worth knowing before you run it:

- **Every Claude Code and Codex session transcript in your home directory** —
  `~/.claude/projects` and `~/.codex/sessions` — to discover recent repositories
  and to attribute changed files to the session that wrote them. This includes
  transcripts from repositories unrelated to the one you are reviewing. It is
  read locally and never sent anywhere except, for the file under review, to
  your own `claude` process.
- **The repository you point it at**, including uncommitted work.

## What it writes

- `~/.changelens/db.sqlite` — review state, findings and dispositions.
- `~/.changelens/worktrees/` — isolated checkouts for reviewing other people's
  PRs. These are real git worktrees registered in your repository, and nothing
  currently cleans them up.
- Your working tree, but **only** via *Apply fix*, only after you confirm the
  exact patch, and never committed.
- Comments on a pull request, but **only** via *Post comments*, and only after
  you have seen the exact payload.

## What it sends

Diffs, file contents and PR metadata go to your local `claude` CLI, which sends
them to Anthropic under your own account and its terms. Changelens has no API
key of its own, no telemetry, and makes no network calls except through `claude`
and `gh`.
