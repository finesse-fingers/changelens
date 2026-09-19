import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** Generous, because `git diff` on a 15k-file repo is not small. */
const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly stderr: string,
    readonly code?: number,
    readonly stdout: string = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Run git with an argv array — never a shell string, so paths and refs with
 * spaces or shell metacharacters cannot be reinterpreted.
 */
export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      maxBuffer: MAX_BUFFER,
      // Keep output stable regardless of the user's git config.
      env: { ...process.env, GIT_PAGER: 'cat', LC_ALL: 'C', GIT_OPTIONAL_LOCKS: '0' },
    });
    return stdout;
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; code?: number; message: string };
    throw new GitError(
      `git ${args.slice(0, 3).join(' ')} failed: ${e.stderr?.trim() || e.message}`,
      args,
      e.stderr ?? '',
      e.code,
      e.stdout ?? '',
    );
  }
}

/**
 * Run git tolerating a specific non-zero exit.
 *
 * `git diff --no-index` exits 1 when the files differ, which is the ordinary
 * case — treating that as failure silently drops every untracked file.
 */
export async function gitAllowExit(cwd: string, args: string[], allowed: number[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (err) {
    if (err instanceof GitError && err.code !== undefined && allowed.includes(err.code)) {
      return (err as GitError & { stdout?: string }).stdout ?? '';
    }
    throw err;
  }
}

/** Returns null instead of throwing, for probes where absence is a valid answer. */
export async function gitOrNull(cwd: string, args: string[]): Promise<string | null> {
  try {
    return await git(cwd, args);
  } catch {
    return null;
  }
}

export async function isGitRepo(cwd: string): Promise<boolean> {
  return (await gitOrNull(cwd, ['rev-parse', '--git-dir'])) !== null;
}

/** Absolute path to the repo root (worktree root, not the common dir). */
export async function repoRoot(cwd: string): Promise<string> {
  return (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();
}

/**
 * Identity that collapses all worktrees of one repository to a single key.
 * `--git-common-dir` points at the shared `.git` for linked worktrees.
 */
export async function repoKey(cwd: string): Promise<string> {
  const common = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim();
  return common.replace(/\/\.git\/?$/, '');
}
