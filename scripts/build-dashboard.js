/* ============================================================
   build-dashboard.js — Static dashboard builder (dependency-free)

   Reads the source dashboard/ files and emits a built version in
   dashboard/out/, preserving relative asset links so the SPA keeps
   working (hash-based routing, fragment fetches, CDN <link>/<script>).

   - Recursively copies every file under dashboard/ (except out/ and
     node_modules) into dashboard/out/.
   - Light minification for .html files: strips HTML comments and
     collapses inter-tag whitespace. Inline <style>/<script> blocks
     are left untouched, so CDN links and CSS are never broken.
   - .js / .svg / everything else is copied verbatim (safe, no
     comment-stripping that could corrupt strings/URLs).

   Usage: node scripts/build-dashboard.js
   ============================================================ */

import { fileURLToPath } from 'node:url';
import { dirname, join, relative, extname } from 'node:path';
import {
  promises as fs,
  existsSync,
  mkdirSync,
  readdirSync,
  statSync,
} from 'node:fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');
const SRC_DIR = join(ROOT, 'dashboard');
const OUT_DIR = join(SRC_DIR, 'out');

// Directories we never descend into / never emit.
const SKIP_DIRS = new Set(['out', 'node_modules']);

/* ─── HTML minification (safe) ─────────────────────────────────── */
function minifyHtml(html) {
  // 1. Remove HTML comments (but not IE conditional commented-out CSS,
  //    which we don't use — safe here).
  let out = html.replace(/<!--[\s\S]*?-->/g, '');
  // 2. Collapse whitespace that sits strictly BETWEEN tags (i.e. text
  //    nodes that are only whitespace). This never touches the contents
  //    of <style>, <script>, <textarea>, or <pre> because those live
  //    *inside* their tags.
  out = out.replace(/>\s+</g, '><');
  // 3. Trim leading/trailing whitespace of the whole document.
  return out.trim();
}

/* ─── Recursive walk ────────────────────────────────────────────── */
function walk(dir, base = dir, acc = []) {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const abs = join(dir, entry);
    const st = statSync(abs);
    if (st.isDirectory()) {
      walk(abs, base, acc);
    } else {
      acc.push({ abs, rel: relative(base, abs).split('\\').join('/') });
    }
  }
  return acc;
}

/* ─── Main ──────────────────────────────────────────────────────── */
async function main() {
  if (!existsSync(SRC_DIR)) {
    console.error(`[build-dashboard] Source directory not found: ${SRC_DIR}`);
    process.exit(1);
  }

  // Clean previous output.
  if (existsSync(OUT_DIR)) {
    await fs.rm(OUT_DIR, { recursive: true, force: true });
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const files = walk(SRC_DIR);
  let htmlCount = 0;
  let copyCount = 0;

  for (const { abs, rel } of files) {
    const dest = join(OUT_DIR, rel);
    mkdirSync(dirname(dest), { recursive: true });

    if (extname(abs).toLowerCase() === '.html') {
      const raw = await fs.readFile(abs, 'utf8');
      const min = minifyHtml(raw);
      await fs.writeFile(dest, min, 'utf8');
      htmlCount++;
    } else {
      // Binary-safe verbatim copy.
      const buf = await fs.readFile(abs);
      await fs.writeFile(dest, buf);
      copyCount++;
    }
  }

  // Report.
  console.log('[build-dashboard] Build complete.');
  console.log(`  source : ${relative(ROOT, SRC_DIR)}/`);
  console.log(`  output : ${relative(ROOT, OUT_DIR)}/`);
  console.log(`  files  : ${files.length} (${htmlCount} html minified, ${copyCount} copied)`);
  for (const { rel } of files.sort((a, b) => a.rel.localeCompare(b.rel))) {
    console.log(`    + ${rel}`);
  }
  process.exit(0);
}

main().catch((err) => {
  console.error('[build-dashboard] Build failed:', err);
  process.exit(1);
});
