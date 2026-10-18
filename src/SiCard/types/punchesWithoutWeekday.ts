// Authored for lool. Not ported from upstream.
//
// Test helper: punches reduced to code and time, for tests that predate
// `weekdayRaw` and compare against fixtures without it.

import type { IPunch } from '../IRaceResultData.ts';

export const withoutWeekday = (punches: IPunch[] | undefined): { code: number; time: unknown }[] =>
  (punches ?? []).map(({ code, time }) => ({ code, time }));
