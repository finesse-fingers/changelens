import { randomUUID } from 'node:crypto';

export type JobKind = 'map' | 'narrate' | 'review' | 'verify' | 'ask' | 'fix';
export type JobStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled';

export interface JobEvent {
  seq: number;
  kind: 'status' | 'progress' | 'partial' | 'result' | 'error';
  at: string;
  data: unknown;
}

export interface Job {
  id: string;
  kind: JobKind;
  status: JobStatus;
  /** Short human line for the status bar: what the job is doing right now. */
  activity: string;
  events: JobEvent[];
  result?: unknown;
  error?: string;
  costUsd: number;
  startedAt: number;
  finishedAt?: number;
  abort: AbortController;
  subscribers: Set<(e: JobEvent) => void>;
}

const jobs = new Map<string, Job>();

export function createJob(kind: JobKind): Job {
  const job: Job = {
    id: randomUUID(),
    kind,
    status: 'queued',
    activity: 'Queued',
    events: [],
    costUsd: 0,
    startedAt: Date.now(),
    abort: new AbortController(),
    subscribers: new Set(),
  };
  jobs.set(job.id, job);
  return job;
}

export function getJob(id: string): Job | undefined {
  return jobs.get(id);
}

export function emit(job: Job, kind: JobEvent['kind'], data: unknown): void {
  const event: JobEvent = { seq: job.events.length, kind, at: new Date().toISOString(), data };
  job.events.push(event);
  // Replayable by sequence number, so a reconnecting tab catches up rather
  // than missing everything that happened while it was away.
  for (const fn of job.subscribers) {
    try {
      fn(event);
    } catch {
      job.subscribers.delete(fn);
    }
  }
}

export function setActivity(job: Job, activity: string): void {
  job.activity = activity;
  emit(job, 'progress', { activity });
}

export function finish(job: Job, status: JobStatus, result?: unknown, error?: string): void {
  job.status = status;
  job.result = result;
  job.error = error;
  job.finishedAt = Date.now();
  emit(job, status === 'done' ? 'result' : 'error', result ?? { error });
}

/** Drop finished jobs after a while so a long session does not grow without bound. */
export function sweep(maxAgeMs = 60 * 60_000): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.finishedAt && now - job.finishedAt > maxAgeMs) jobs.delete(id);
  }
}
