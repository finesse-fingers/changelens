import type { ChangedFile, DiffLine, FileStatus, Hunk, ChangeOrigin } from '../../shared/types.js';
import { hashHunk } from './hash.js';

/**
 * Unified-diff parser.
 *
 * Hand-rolled rather than pulled from npm because the overlay needs exact
 * line-number provenance for every rendered row — findings anchor to
 * 1-indexed new-file line numbers, and an off-by-one puts a bug report on the
 * wrong line.
 */

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: (.*))?$/;

interface PartialFile {
  path: string;
  oldPath?: string;
  status: FileStatus;
  isBinary: boolean;
  similarity?: number;
  hunks: Hunk[];
}

export function parseUnifiedDiff(raw: string, origin: ChangeOrigin): ChangedFile[] {
  const out: ChangedFile[] = [];
  if (!raw.trim()) return out;

  // A diff ends with a newline, so the final split element is an empty string
  // that is not content. Counting it as a context line shifts every subsequent
  // line number by one and puts findings on the wrong row.
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();
  let current: PartialFile | null = null;
  let hunk: Hunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  const flushHunk = () => {
    if (current && hunk) {
      hunk.contentHash = hashHunk(hunk.lines);
      current.hunks.push(hunk);
    }
    hunk = null;
  };

  const flushFile = () => {
    flushHunk();
    if (!current) return;
    const additions = current.hunks.reduce((n, h) => n + h.additions, 0);
    const deletions = current.hunks.reduce((n, h) => n + h.deletions, 0);
    out.push({
      path: current.path,
      oldPath: current.oldPath,
      status: current.status,
      origin,
      additions,
      deletions,
      isBinary: current.isBinary,
      noise: null, // assigned by the classifier, which needs the -w pass
      tier: 'normal',
      similarity: current.similarity,
      hunks: current.hunks,
      language: languageOf(current.path),
    });
    current = null;
  };

  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      flushFile();
      const paths = parseDiffGitPaths(line);
      current = {
        path: paths.to,
        oldPath: paths.from !== paths.to ? paths.from : undefined,
        status: 'modified',
        isBinary: false,
        hunks: [],
      };
      continue;
    }
    if (!current) continue;

    if (line.startsWith('new file mode')) { current.status = 'added'; continue; }
    if (line.startsWith('deleted file mode')) { current.status = 'deleted'; continue; }
    if (line.startsWith('similarity index ')) {
      current.similarity = parseInt(line.slice('similarity index '.length), 10);
      continue;
    }
    if (line.startsWith('rename from ')) {
      current.status = 'renamed';
      current.oldPath = unquotePath(line.slice('rename from '.length));
      continue;
    }
    if (line.startsWith('rename to ')) {
      current.status = 'renamed';
      current.path = unquotePath(line.slice('rename to '.length));
      continue;
    }
    if (line.startsWith('copy from ')) { current.status = 'copied'; continue; }
    if (line.startsWith('Binary files ') || line.startsWith('GIT binary patch')) {
      current.isBinary = true;
      continue;
    }
    if (line.startsWith('--- ') || line.startsWith('+++ ') || line.startsWith('index ') ||
        line.startsWith('old mode') || line.startsWith('new mode')) {
      continue;
    }

    const m = HUNK_RE.exec(line);
    if (m) {
      flushHunk();
      oldLine = parseInt(m[1], 10);
      newLine = parseInt(m[3], 10);
      hunk = {
        id: `${current.path}@${current.hunks.length}`,
        filePath: current.path,
        index: current.hunks.length,
        oldStart: oldLine,
        oldLines: m[2] ? parseInt(m[2], 10) : 1,
        newStart: newLine,
        newLines: m[4] ? parseInt(m[4], 10) : 1,
        section: (m[5] ?? '').trim(),
        lines: [],
        additions: 0,
        deletions: 0,
        contentHash: '',
      };
      continue;
    }

    if (!hunk) continue;

    // "\ No newline at end of file" annotates the preceding line; it is not content.
    if (line.startsWith('\\')) continue;

    const marker = line[0];
    const text = line.slice(1);
    let entry: DiffLine;
    if (marker === '+') {
      entry = { kind: 'add', oldLine: null, newLine: newLine++, text };
      hunk.additions++;
    } else if (marker === '-') {
      entry = { kind: 'del', oldLine: oldLine++, newLine: null, text };
      hunk.deletions++;
    } else if (marker === ' ' || line === '') {
      // A truly empty line in the diff body is an empty context line.
      entry = { kind: 'context', oldLine: oldLine++, newLine: newLine++, text };
    } else {
      continue; // trailing junk between files
    }
    hunk.lines.push(entry);
  }

  flushFile();
  return out;
}

/**
 * `diff --git a/x b/y` with optional quoting. Splitting on ' b/' is wrong for
 * paths that contain that substring, so walk from the known prefixes instead.
 */
function parseDiffGitPaths(line: string): { from: string; to: string } {
  const rest = line.slice('diff --git '.length);
  if (rest.startsWith('"')) {
    // Quoted form: "a/path" "b/path"
    const close = findQuoteEnd(rest, 0);
    const from = unquotePath(rest.slice(0, close + 1));
    const toRaw = rest.slice(close + 2);
    return { from: stripPrefix(from), to: stripPrefix(unquotePath(toRaw)) };
  }
  // Unquoted: a/<from> b/<to>. The from-path always starts at index 2 ("a/").
  // Find the separator by looking for " b/" scanning from the right, which is
  // correct because the to-path cannot itself contain " b/" after its own "b/".
  const idx = rest.lastIndexOf(' b/');
  if (idx === -1) return { from: rest, to: rest };
  return { from: stripPrefix(rest.slice(0, idx)), to: stripPrefix(rest.slice(idx + 1)) };
}

function findQuoteEnd(s: string, start: number): number {
  for (let i = start + 1; i < s.length; i++) {
    if (s[i] === '\\') { i++; continue; }
    if (s[i] === '"') return i;
  }
  return s.length - 1;
}

function stripPrefix(p: string): string {
  return p.replace(/^[ab]\//, '');
}

/** git quotes paths with special characters using C-style escapes. */
function unquotePath(p: string): string {
  const t = p.trim();
  if (!t.startsWith('"')) return stripPrefix(t);
  const inner = t.slice(1, t.endsWith('"') ? -1 : undefined);
  const decoded = inner.replace(/\\(\d{3}|.)/g, (_, esc: string) => {
    if (/^\d{3}$/.test(esc)) return String.fromCharCode(parseInt(esc, 8));
    const map: Record<string, string> = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\' };
    return map[esc] ?? esc;
  });
  return stripPrefix(decoded);
}

const LANG_BY_EXT: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx', mjs: 'javascript',
  cjs: 'javascript', mts: 'typescript', cts: 'typescript',
  py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java', kt: 'kotlin',
  cs: 'csharp', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', c: 'c', h: 'c', hpp: 'cpp',
  swift: 'swift', php: 'php', scala: 'scala', sh: 'bash', bash: 'bash', zsh: 'bash',
  sql: 'sql', json: 'json', yaml: 'yaml', yml: 'yaml', toml: 'toml', xml: 'xml',
  html: 'html', css: 'css', scss: 'scss', md: 'markdown', mdx: 'mdx',
  dockerfile: 'docker', tf: 'terraform', proto: 'proto', graphql: 'graphql',
  vue: 'vue', svelte: 'svelte', dart: 'dart', ex: 'elixir', exs: 'elixir',
};

export function languageOf(path: string): string | undefined {
  const base = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'docker';
  if (base === 'makefile') return 'make';
  const ext = base.slice(base.lastIndexOf('.') + 1);
  return LANG_BY_EXT[ext];
}
