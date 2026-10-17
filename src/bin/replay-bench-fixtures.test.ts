// Authored for lool. Not ported from upstream.
//
// regression: the production `replayFixture()` must round-trip the
// committed bench fixtures byte-for-byte (ts_ms normalised). Prior to
// the fix, this failed in two ways:
//
//   1. replayFixture hard-coded `card_inserted.card_type = 'SI5'`, so SI9 /
//      SI10 / SIAC inserted-card lines disagreed with what record produced.
//   2. The recorded `.expected.json` includes two consecutive
//      `connection_changed/opening` events (bin emits one manually, then
//      `SiMainStation.readCards()` emits another). replayFixture only
//      emitted one.
//
// This test calls the EXPORTED replayFixture against each of the four
// committed bench fixtures and asserts `matches: true`. Distinct from
// integration/benchReplay.test.ts (which uses an inline mini-replay engine
// and filters out connection_changed events) — that test catches wire-event
// regressions; THIS test catches production --replay regressions.
//
// See NOTICE.md for cumulative attribution.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as url from 'node:url';

import { replayFixture } from './replay.ts';

const HERE = path.dirname(url.fileURLToPath(import.meta.url));
const FIXTURE_DIR = path.resolve(HERE, '..', '..', 'tests', 'fixtures', 'bench');

const CARD_SLUGS: ReadonlyArray<string> = ['si5', 'si9', 'si10', 'siac'];

describe('production replayFixture round-trips all committed bench fixtures', () => {
  for (const slug of CARD_SLUGS) {
    test(`replayFixture matches=true for ${slug}-bench-001`, async () => {
      const basename = path.join(FIXTURE_DIR, `${slug}-bench-001`);
      const result = await replayFixture(basename, { allowedRoots: [FIXTURE_DIR] });

      assert.strictEqual(
        result.matches,
        true,
        `replayFixture(${slug}-bench-001) must match bench truth byte-for-byte\n` +
          `diff:\n${result.diff ?? '(no diff captured)'}`
      );
    });
  }
});
