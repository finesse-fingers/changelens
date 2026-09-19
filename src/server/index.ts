import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { resolveSnapshot } from './git/snapshot.js';
import { extractAllUnits } from './git/units.js';
import { recentRepos } from './recents.js';
import { parsePrRef, prForCurrentBranch, listPrs, GhError } from './gh/pr.js';
import { gitOrNull, isGitRepo, repoRoot } from './git/exec.js';
import { createJob, emit, finish, getJob, setActivity, type JobEvent } from './jobs/registry.js';
import { runMapJob } from './jobs/map.js';
import { runReviewJob } from './jobs/review.js';
import { runFixJob } from './jobs/fix.js';
import { narrateAll } from './jobs/narrate.js';
import { previewComments, postComments, prepareWorktree, type CommentPreview } from './gh/writeback.js';
import { recipeFor, recipeMatrix, type Effort } from './jobs/recipes.js';
import { assistantText, isAssistant } from './runner/events.js';
import { probeCapabilities, cachedCapabilities } from './runner/capability.js';
import { buildIndex, provenanceFor } from './provenance/index.js';
import { persistSnapshot, setUnitState, setDisposition, dispositionsFor, type UnitState } from './db/index.js';
import type { ChangedFile, Finding, Snapshot, TargetSpec } from '../shared/types.js';
import type { ReviewUnit } from './git/units.js';

/**
 * Snapshots the UI has loaded, so a job can be started by id without the client
 * shipping the whole diff back. Cleared when the process exits — nothing here
 * is authoritative, it is a cache of work already done this session.
 */
const snapshots = new Map<
  string,
  { snapshot: Snapshot; files: ChangedFile[]; units: ReviewUnit[]; reviewId: number; dbSnapshotId: number }
>();

/** Findings from the most recent review of each snapshot, for write-back. */
const lastFindings = new Map<string, Finding[]>();

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Local-only server.
 *
 * It can spawn `claude` subprocesses against your repos, so it binds to
 * loopback: nothing off this machine can reach it. There is no auth beyond
 * that. Anything already running as your user could read these repos and run
 * `claude` directly anyway, so a token bought little against local processes,
 * and every side-effecting route takes a JSON body — which a browser will not
 * send cross-origin without a preflight this server does not answer.
 */
const PORT = Number(process.env.CHANGELENS_PORT ?? 4317);

const app = Fastify({ logger: false, bodyLimit: 32 * 1024 * 1024 });

app.setErrorHandler((err: unknown, _req, reply) => {
  const e = err as { message?: string; statusCode?: number };
  const status = err instanceof GhError ? 400 : (e.statusCode ?? 500);
  const hint = err instanceof GhError ? err.hint : undefined;
  reply.code(status).send({ error: e.message ?? 'Unknown error', hint });
});

// Read from package.json rather than repeated here: two copies of a version
// number drift on the first release that forgets one of them.
const { version } = JSON.parse(
  readFileSync(new URL('../../package.json', import.meta.url), 'utf8'),
) as { version: string };

app.get('/api/health', async () => ({ ok: true, version }));

app.get('/api/repos/recent', async () => ({ repos: await recentRepos() }));

/** Probe a path the user typed, so the picker can validate before committing. */
app.get('/api/repo/inspect', async (req) => {
  const { path } = req.query as { path?: string };
  if (!path) throw Object.assign(new Error('path is required'), { statusCode: 400 });
  if (!(await isGitRepo(path))) {
    throw Object.assign(new Error(`${path} is not a git repository`), { statusCode: 400 });
  }
  const root = await repoRoot(path);
  const branch = (await gitOrNull(root, ['branch', '--show-current']))?.trim() || undefined;
  const dirty = Boolean((await gitOrNull(root, ['status', '--porcelain']))?.trim());
  const pr = await prForCurrentBranch(root);
  const branches = (await gitOrNull(root, [
    'for-each-ref', '--sort=-committerdate', '--count=40',
    '--format=%(refname:short)', 'refs/heads', 'refs/remotes/origin',
  ]))?.split('\n').map((s) => s.trim()).filter(Boolean) ?? [];
  return { root, branch, dirty, pr, branches };
});

/**
 * Open PRs in this repo that are the user's to deal with.
 *
 * Separate from `/repo/inspect` rather than folded into it: inspect already
 * runs five serial awaits including a network `gh pr view`, and it fires on
 * every repo click. Two more round trips there would slow down selecting a
 * repo for a list most clicks never open.
 */
app.get('/api/repo/prs', async (req) => {
  const { path } = req.query as { path?: string };
  if (!path) throw Object.assign(new Error('path is required'), { statusCode: 400 });
  if (!(await isGitRepo(path))) {
    throw Object.assign(new Error(`${path} is not a git repository`), { statusCode: 400 });
  }
  // 200 even when both queries failed: the reason travels per group, and the
  // picker's red error box is reserved for things that actually stop you.
  // Failing this optional convenience must not read like a blocked action.
  return listPrs(await repoRoot(path));
});

/**
 * Resolve a target into a snapshot plus its diff and review units.
 *
 * Nothing is persisted and no model is invoked here — this is the cheap,
 * auditable step the picker shows before any work begins.
 */
app.post('/api/snapshot', async (req) => {
  const body = req.body as TargetSpec & { prRef?: string };
  if (body.kind === 'pr' && body.prRef && body.prNumber === undefined) {
    const n = parsePrRef(body.prRef);
    if (n === null) throw Object.assign(new Error(`Could not read a PR number from "${body.prRef}"`), { statusCode: 400 });
    body.prNumber = n;
  }
  const { snapshot, diff } = await resolveSnapshot(body);
  const units = extractAllUnits(diff.files);

  // Persisting here is what makes review survive an agent pushing mid-review:
  // units are identified by content, so a later snapshot that re-derives the
  // same change lands on the same row and keeps its state.
  const { reviewId, snapshotId, states, resume } = persistSnapshot(snapshot, units);
  snapshots.set(snapshot.id, {
    snapshot, files: diff.files, units, reviewId, dbSnapshotId: snapshotId,
  });

  return {
    snapshot,
    diff,
    units,
    states,
    resume,
    dispositions: dispositionsFor(reviewId),
    summary: {
      reviewable: diff.files.filter((f) => f.tier === 'normal').length,
      digest: diff.files.filter((f) => f.tier === 'digest').length,
      excluded: diff.files.filter((f) => f.tier === 'excluded').length,
      units: units.length,
    },
  };
});

/** Persist a review decision so it outlives this snapshot. */
app.post('/api/unit-state', async (req) => {
  const { snapshotId, unitId, state } = req.body as {
    snapshotId: string; unitId: string; state: UnitState;
  };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot'), { statusCode: 404 });
  const unit = entry.units.find((u) => u.id === unitId);
  if (!unit) throw Object.assign(new Error('Unknown unit'), { statusCode: 404 });
  setUnitState(entry.reviewId, entry.dbSnapshotId, unit.filePath, unit.contentHash, unit.ordinal, state);
  return { ok: true };
});

/** Triage decisions are keyed by fingerprint so they survive a re-review. */
app.post('/api/disposition', async (req) => {
  const { snapshotId, fingerprint, disposition, note } = req.body as {
    snapshotId: string; fingerprint: string; disposition: string; note?: string;
  };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot'), { statusCode: 404 });
  setDisposition(entry.reviewId, fingerprint, disposition, note);
  return { ok: true };
});

app.get('/api/recipes', async () => ({ matrix: recipeMatrix() }));

/**
 * Who wrote each changed file, and what they were asked to do.
 *
 * Answers the question that gets lost when several agents work in parallel:
 * not "which commit touched this" but "which session produced this, and what
 * was the prompt".
 */
app.get('/api/provenance', async (req) => {
  const { snapshotId } = req.query as { snapshotId?: string };
  const entry = snapshotId ? snapshots.get(snapshotId) : undefined;
  if (!entry) throw Object.assign(new Error('Unknown snapshot'), { statusCode: 404 });
  const paths = entry.files.map((f) => f.path);
  const byFile = await provenanceFor(entry.snapshot.repoKey, paths);
  return { byFile, attributed: Object.keys(byFile).length, total: paths.length };
});

/**
 * Start a /code-review run. Findings stream in as they are reported, so a
 * multi-minute review fills the UI progressively instead of sitting blank.
 */
app.post('/api/review', async (req) => {
  const { snapshotId, effort, model } = req.body as {
    snapshotId: string;
    effort: Effort;
    model?: string;
  };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot — resolve it again'), { statusCode: 404 });

  const job = createJob('review');
  job.status = 'running';
  const recipe = recipeFor(model, effort);
  setActivity(job, `Starting ${effort} review — ${recipe.tag}`);

  void (async () => {
    try {
      const res = await runReviewJob(entry.snapshot, entry.units, {
        effort,
        model,
        signal: job.abort.signal,
        onFindings: (findings) => {
          // Keep the latest set available for write-back even mid-run.
          lastFindings.set(snapshotId, findings);
          emit(job, 'partial', { findings });
        },
        onEvent: (e) => {
          if (!isAssistant(e)) return;
          const text = assistantText(e).trim();
          if (text) setActivity(job, text.slice(0, 160));
        },
      });
      job.costUsd = res.costUsd;
      lastFindings.set(snapshotId, res.findings);
      if (res.incomplete) finish(job, 'failed', { ...res, recipe }, res.incomplete);
      else finish(job, 'done', { ...res, recipe });
    } catch (err) {
      finish(job, 'failed', undefined, (err as Error).message);
    }
  })();

  return { jobId: job.id, recipe };
});

/*
 * Write-back. Every one of these is two-step by construction: a preview that
 * sends nothing, then an explicit confirmation. Authority at one gate never
 * implies the next.
 */

app.post('/api/comments/preview', async (req) => {
  const { snapshotId, findingIds } = req.body as { snapshotId: string; findingIds: string[] };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot'), { statusCode: 404 });
  if (entry.snapshot.kind !== 'pr' || entry.snapshot.prNumber === undefined) {
    throw Object.assign(new Error('Comments can only be posted to a pull request target.'), { statusCode: 400 });
  }
  const selected = (lastFindings.get(snapshotId) ?? []).filter((f) => findingIds.includes(f.id));
  const changedPaths = new Set(entry.files.map((f) => f.path));
  return previewComments(entry.snapshot.repoRoot, entry.snapshot.prNumber, selected, changedPaths);
});

app.post('/api/comments/post', async (req) => {
  const { snapshotId, preview } = req.body as { snapshotId: string; preview: CommentPreview };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot'), { statusCode: 404 });
  // Post exactly what was shown — never rebuild the payload here, or the user
  // would be confirming something other than what gets sent.
  return postComments(entry.snapshot.repoRoot, preview);
});

app.post('/api/pr/worktree', async (req) => {
  const { repoRoot, prNumber } = req.body as { repoRoot: string; prNumber: number };
  return prepareWorktree(repoRoot, prNumber);
});

app.post('/api/fix', async (req) => {
  const { snapshotId, findingId, model } = req.body as {
    snapshotId: string; findingId: string; model?: string;
  };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot'), { statusCode: 404 });
  const finding = (lastFindings.get(snapshotId) ?? []).find((f) => f.id === findingId);
  if (!finding) throw Object.assign(new Error('Unknown finding'), { statusCode: 404 });

  const job = createJob('fix');
  job.status = 'running';
  setActivity(job, `Applying: ${finding.shortSummary ?? finding.summary}`);

  void (async () => {
    try {
      const res = await runFixJob(entry.snapshot, finding, {
        model,
        signal: job.abort.signal,
        onEvent: (e) => {
          if (!isAssistant(e)) return;
          const text = assistantText(e).trim();
          if (text) setActivity(job, text.slice(0, 160));
        },
      });
      job.costUsd = res.costUsd;
      if (res.incomplete) finish(job, 'failed', res, res.incomplete);
      else finish(job, 'done', res);
    } catch (err) {
      finish(job, 'failed', undefined, (err as Error).message);
    }
  })();

  return { jobId: job.id };
});

app.get('/api/capabilities', async (req) => {
  const { path } = req.query as { path?: string };
  const cached = cachedCapabilities();
  if (cached) return cached;
  if (!path) return { probed: false };
  return probeCapabilities(path);
});

/**
 * Start the map job. Returns immediately with a job id; progress and the final
 * result arrive over SSE, because this takes about a minute and a UI that shows
 * nothing until it finishes reads as a hang.
 */
app.post('/api/map', async (req) => {
  const { snapshotId, model } = req.body as { snapshotId: string; model?: string };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot — resolve it again'), { statusCode: 404 });

  const job = createJob('map');
  job.status = 'running';
  setActivity(job, 'Reading the diff and intent evidence');

  void (async () => {
    try {
      const res = await runMapJob(entry.snapshot, entry.files, entry.units, {
        model,
        signal: job.abort.signal,
        onEvent: (e) => {
          if (!isAssistant(e)) return;
          const text = assistantText(e).trim();
          if (text) setActivity(job, text.slice(0, 160));
        },
      });
      job.costUsd = res.costUsd;
      if (res.incomplete) {
        // An incomplete map is never presented as a finished one.
        finish(job, 'failed', undefined, res.incomplete);
      } else {
        finish(job, 'done', res);
      }
    } catch (err) {
      finish(job, 'failed', undefined, (err as Error).message);
    }
  })();

  return { jobId: job.id };
});

/**
 * Narrate the diff: plain-language annotations anchored to each change.
 *
 * Shards stream in as they land, so the overlay fills file by file rather than
 * appearing all at once several minutes later.
 */
app.post('/api/narrate', async (req) => {
  const { snapshotId, model, effort, cards, order } = req.body as {
    snapshotId: string;
    model?: string;
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    cards?: { title: string; files: string[] }[];
    order?: string[];
  };
  const entry = snapshots.get(snapshotId);
  if (!entry) throw Object.assign(new Error('Unknown snapshot — resolve it again'), { statusCode: 404 });

  const byFile = new Map<string, string>();
  for (const c of cards ?? []) for (const f of c.files) byFile.set(f, c.title);

  const job = createJob('narrate');
  job.status = 'running';
  const total = entry.files.filter((f) => f.tier === 'normal' && !f.isBinary).length;
  setActivity(job, `Annotating ${total} file(s)`);

  void (async () => {
    let done = 0;
    const inFlight = new Set<string>();
    try {
      const res = await narrateAll(
        entry.snapshot, entry.files, entry.units, (p) => byFile.get(p),
        {
          model,
          effort,
          order,
          signal: job.abort.signal,
          // The margin shows nothing for a file that has not been reached and
          // nothing for a file with no notes, so in-flight files are named
          // explicitly rather than left looking like silence.
          onStart: (filePath) => {
            inFlight.add(filePath);
            emit(job, 'progress', { inFlight: [...inFlight] });
          },
          onShard: (shard) => {
            done++;
            inFlight.delete(shard.filePath);
            setActivity(job, `Annotated ${done}/${total} — ${shard.filePath.split('/').pop()}`);
            emit(job, 'partial', { narrations: shard.narrations, inFlight: [...inFlight] });
          },
        },
      );
      job.costUsd = res.costUsd;
      // Partial narration is still useful, so a failed shard degrades rather
      // than failing the job; the response names which files went un-narrated.
      finish(job, 'done', res);
    } catch (err) {
      finish(job, 'failed', undefined, (err as Error).message);
    }
  })();

  return { jobId: job.id };
});

app.get('/api/jobs/:id/stream', async (req, reply) => {
  const { id } = req.params as { id: string };
  const since = Number((req.query as { since?: string }).since ?? -1);
  const job = getJob(id);
  if (!job) throw Object.assign(new Error('Unknown job'), { statusCode: 404 });

  reply.raw.writeHead(200, {
    'content-type': 'text/event-stream',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });

  const send = (e: JobEvent) => {
    reply.raw.write(`id: ${e.seq}\nevent: ${e.kind}\ndata: ${JSON.stringify(e)}\n\n`);
  };
  // Replay anything the client missed before subscribing to new events.
  for (const e of job.events) if (e.seq > since) send(e);
  if (job.status === 'done' || job.status === 'failed') {
    reply.raw.end();
    return reply;
  }

  job.subscribers.add(send);
  const keepAlive = setInterval(() => reply.raw.write(': ping\n\n'), 15_000);
  req.raw.on('close', () => {
    clearInterval(keepAlive);
    job.subscribers.delete(send);
  });
  return reply;
});

app.post('/api/jobs/:id/cancel', async (req) => {
  const { id } = req.params as { id: string };
  const job = getJob(id);
  if (!job) throw Object.assign(new Error('Unknown job'), { statusCode: 404 });
  job.abort.abort();
  return { ok: true };
});

// Serve the built UI when it exists; in dev, Vite serves it and proxies here.
const webDist = join(here, '..', '..', 'dist', 'web');
if (existsSync(webDist)) {
  await app.register(fastifyStatic, { root: webDist });
  app.setNotFoundHandler((_req, reply) => reply.sendFile('index.html'));
}

// Warm the provenance index in the background: a first scan takes seconds and
// should not block the first page load.
void buildIndex().catch(() => undefined);

const url = await app.listen({ port: PORT, host: '127.0.0.1' });
console.log(`\n  Changelens — ${url}\n`);
if (process.env.CHANGELENS_OPEN !== '0' && existsSync(webDist)) {
  const { spawn } = await import('node:child_process');
  // Each platform has its own launcher, and none of them is guaranteed to be
  // there — a headless Linux box has no `xdg-open`. An unhandled `error` event
  // on a child process throws, so without the listener below a missing launcher
  // takes the whole server down one line after it announced itself as ready.
  const launcher: [string, string[]] =
    process.platform === 'darwin' ? ['open', [url]]
    : process.platform === 'win32' ? ['cmd', ['/c', 'start', '', url]]
    : ['xdg-open', [url]];
  const child = spawn(launcher[0], launcher[1], { stdio: 'ignore', detached: true });
  child.on('error', () => console.log(`  Could not open a browser for you — visit ${url}\n`));
  child.unref();
}
