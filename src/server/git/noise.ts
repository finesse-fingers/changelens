import type { ChangedFile, NoiseReason, NoiseTier } from '../../shared/types.js';

/**
 * Deterministic, pre-LLM noise classification.
 *
 * Every rule here is cheap and certain. Anything requiring judgement is left to
 * the `map` job — spending model tokens narrating a lockfile is exactly the
 * waste this tool exists to remove.
 */

const LOCKFILES = new Set([
  'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lockb', 'bun.lock',
  'Cargo.lock', 'poetry.lock', 'uv.lock', 'Pipfile.lock', 'Gemfile.lock',
  'composer.lock', 'go.sum', 'mix.lock', 'pubspec.lock', 'packages.lock.json',
  'flake.lock', 'gradle.lockfile',
]);

const GENERATED_DIRS = [
  'dist/', 'build/', 'out/', '__generated__/', 'generated/', '.next/',
  'coverage/', '.nuxt/', 'target/debug/', 'target/release/', 'obj/', 'bin/Debug/',
  'bin/Release/', '.terraform/', 'node_modules/',
];

const GENERATED_PATTERNS = [
  /\.generated\.[^/]+$/, /\.g\.[^/]+$/, /\.pb\.go$/, /_pb2\.pyi?$/, /_pb\.js$/,
  /\.min\.(js|css)$/, /\.bundle\.js$/, /\.map$/, /\.d\.ts\.map$/,
  /^.*\.designer\.cs$/i, /\.freezed\.dart$/, /\.pyc$/,
];

const VENDORED_DIRS = ['vendor/', 'third_party/', 'thirdparty/', 'Pods/', 'external/'];

const FIXTURE_DIRS = ['__snapshots__/', 'fixtures/', 'testdata/', 'recordings/', 'cassettes/'];
const FIXTURE_PATTERNS = [/\.snap$/, /\.golden$/, /\.approved\.[^/]+$/];

/** Above this, a single file's diff is treated as bulk rather than reviewable prose. */
const OVERSIZED_CHANGED_LINES = 1500;

function matchesDir(path: string, dirs: string[]): boolean {
  // Match at the path root or at any segment boundary.
  return dirs.some((d) => path.startsWith(d) || path.includes('/' + d));
}

/**
 * Classify a file as noise, or return null if it deserves real review.
 *
 * `whitespaceOnlyPaths` comes from a second `git diff -w` pass — a file that
 * disappears when whitespace is ignored changed only in formatting.
 */
export function classifyNoise(
  file: Pick<ChangedFile, 'path' | 'status' | 'isBinary' | 'additions' | 'deletions' | 'similarity'>,
  whitespaceOnlyPaths: ReadonlySet<string>,
): NoiseReason | null {
  const path = file.path;
  const base = path.slice(path.lastIndexOf('/') + 1);

  if (file.isBinary) return 'binary';
  if (LOCKFILES.has(base) || /\.lock$/.test(base)) return 'lockfile';
  if (matchesDir(path, GENERATED_DIRS)) return 'generated';
  if (GENERATED_PATTERNS.some((re) => re.test(path))) return 'generated';
  if (matchesDir(path, VENDORED_DIRS)) return 'vendored';
  if (matchesDir(path, FIXTURE_DIRS) || FIXTURE_PATTERNS.some((re) => re.test(path))) {
    return 'snapshot-fixture';
  }

  // A rename git scored at 100% similarity moved bytes without changing them.
  if (file.status === 'renamed' && file.similarity === 100 && file.additions === 0 && file.deletions === 0) {
    return 'pure-rename';
  }

  if (whitespaceOnlyPaths.has(path)) return 'whitespace-only';

  if (file.additions + file.deletions > OVERSIZED_CHANGED_LINES) return 'oversized';

  return null;
}

/**
 * Noise is three tiers, not a boolean.
 *
 * `excluded` never reaches a model and never becomes a review unit.
 * `digest` collapses to a single unit with a one-line summary — a generated
 * types file gaining 43 lines is often the highest-signal item in a PR,
 * because it means a database column moved. Dropping it silently would be a
 * correctness bug in the reviewer, not a saving.
 */
export function tierFor(reason: NoiseReason | null): NoiseTier {
  if (reason === null) return 'normal';
  switch (reason) {
    case 'generated':
    case 'oversized':
    case 'snapshot-fixture':
      return 'digest';
    default:
      return 'excluded';
  }
}

/** Human-readable label for the Noise bucket in the UI. */
export const NOISE_LABELS: Record<NoiseReason, string> = {
  lockfile: 'Lockfile',
  generated: 'Generated',
  vendored: 'Vendored',
  'pure-rename': 'Moved unchanged',
  'whitespace-only': 'Formatting only',
  binary: 'Binary',
  oversized: 'Bulk change',
  'snapshot-fixture': 'Fixture / snapshot',
};
