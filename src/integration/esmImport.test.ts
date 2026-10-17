// Authored for lool. Not ported from upstream.
//
// regression: (post-bench) flagged that ESM consumers
// could not construct `SerialTransport` from the built ESM bundle because
// the source used a bare `require('serialport')`. The fix lives in
// `src/transport/SerialTransport.ts` (createRequire(import.meta.url)).
//
// This test exercises the ACTUAL built `dist/index.mjs` so a future regression
// to bare-require or `Dynamic require of "serialport" is not supported` ends
// up red here. The dist isn't always present (tests run before build in some
// flows), so when it's missing this test is a no-op — the prebuild gate in
// `pnpm test` is the right place to enforce dist-presence, not this test.
//
// See NOTICE.md for cumulative attribution.

import { after, before, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as url from 'node:url';

// Resolve `dist/index.mjs` relative to this test file. Layout:
//   src/integration/esmImport.test.ts  -> dist/index.mjs
//   ../../dist/index.mjs
const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const DIST_MJS = path.resolve(HERE, '..', '..', 'dist', 'index.mjs');

describe('ESM consumers can construct SerialTransport from dist/index.mjs', () => {
  // Stash to detect "test ran but did nothing" cleanly.
  let skipped = false;
  before(() => {
    if (!fs.existsSync(DIST_MJS)) {
      skipped = true;
    }
  });

  after(() => {
    if (skipped) {
      // Surface visibility in the spec reporter: this isn't a failure (the
      // built dist is genuinely absent before the build step), but a future
      // maintainer should be able to grep for "esmImport skipped" if the
      // suite count looks off.
      process.stderr.write(
        'esmImport.test.ts skipped: dist/index.mjs missing (build first with `pnpm build`)\n'
      );
    }
  });

  test('SerialTransport export is a constructor in the built ESM bundle', async (t) => {
    if (skipped) {
      t.skip('dist/index.mjs not present — run `pnpm build` first');
      return;
    }
    // Use a file:// URL so the dynamic import resolves the same way Node's
    // ESM loader would for an installed consumer. Bypasses the TS loader.
    const distUrl = url.pathToFileURL(DIST_MJS).href;
    const mod = (await import(distUrl)) as Record<string, unknown>;
    assert.strictEqual(
      typeof mod.SerialTransport,
      'function',
      `Expected SerialTransport to be a constructor function in ${DIST_MJS}; got ${typeof mod.SerialTransport}. ` +
        'This likely means the bare `require("serialport")` regressed in src/transport/SerialTransport.ts.'
    );
  });
});
