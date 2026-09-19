/**
 * Copy the server's non-TypeScript files into the build.
 *
 * `tsc` emits JavaScript and nothing else, so `src/server/db/schema.sql` — which
 * the database opens on first use — never reaches `dist/`. Without this the
 * build succeeds, the server boots, the picker loads, and the first snapshot
 * dies on a path the user has never heard of.
 *
 * This was `rsync`, which is absent from slim Linux images and from Windows,
 * and whose quoting breaks under cmd even where it exists. `node:fs` is already
 * a hard dependency of everything here.
 */
import { cpSync } from 'node:fs';

cpSync('src/server', 'dist/server', {
  recursive: true,
  // Directories return true and are recursed into; only `.ts` sources are
  // skipped, so a future asset of any other kind is carried without a change.
  filter: (src) => !src.endsWith('.ts'),
});
