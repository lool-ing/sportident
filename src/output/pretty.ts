// Authored for lool. Not ported from upstream.
//
// Human-readable rendering of NDJSON events for `lool-readout --pretty`.
// Stdout stays pure NDJSON by default; this is an opt-in operator view
// that takes the exact same event objects and prints a punch table per card.
//
// See NOTICE.md for cumulative attribution.

import type { HalfDayClock, NdjsonEvent, NdjsonPunch } from './ndjson.ts';

const HALF_DAY = 43200;
const DAY = 86400;

const toSeconds = (c: HalfDayClock | NdjsonPunch | null): number | null =>
  c && c.half_day !== null && c.seconds_in_half_day !== null
    ? c.half_day * HALF_DAY + c.seconds_in_half_day
    : null;

const pad2 = (n: number): string => String(n).padStart(2, '0');

const clockText = (s: number | null): string =>
  s === null
    ? '—'
    : `${pad2(Math.floor(s / 3600))}:${pad2(Math.floor(s / 60) % 60)}:${pad2(s % 60)}`;

/** Elapsed seconds from `from` to `to`, wrapping once over the card's clock
 *  period: 24 h, or 12 h for SI5, which has no AM/PM bit (ADR-0009). */
const elapsed = (from: number | null, to: number | null, period: number): number | null =>
  from === null || to === null ? null : (to - from + period) % period;

const durationText = (s: number | null): string => {
  if (s === null) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h > 0 ? `${h}:${pad2(m)}:${pad2(s % 60)}` : `${m}:${pad2(s % 60)}`;
};

const wallClock = (ts_ms: number): string => new Date(ts_ms).toTimeString().slice(0, 8);

const formatCardRead = (e: Extract<NdjsonEvent, { event: 'card_read' }>): string => {
  // Collapse back-to-back punches on the same control (SIAC double-punching)
  // into one row; the first punch's time counts.
  const visits: { code: number; time: number | null; count: number }[] = [];
  for (const p of e.punches) {
    const last = visits.at(-1);
    if (last && last.code === p.code) last.count++;
    else visits.push({ code: p.code, time: toSeconds(p), count: 1 });
  }

  const period = e.card_type === 'SI5' ? HALF_DAY : DAY;
  const start = toSeconds(e.start);
  const finish = toSeconds(e.finish);
  const holder = e.card_holder ?? {};
  const name = [holder.first_name, holder.last_name].filter(Boolean).join(' ');

  const lines = [
    `── ${e.card_type} ${e.card_number}${name ? `  ${name}` : ''} `.padEnd(52, '─'),
    `  Check    ${clockText(toSeconds(e.check))}`,
    `  Start    ${clockText(start)}`,
    '',
    '    #  Code      Time     Split     Total',
  ];
  let prev = start;
  visits.forEach((v, i) => {
    lines.push(
      (
        `  ${String(i + 1).padStart(3)}  ${String(v.code).padStart(4)}  ${clockText(v.time)}` +
        `  ${durationText(elapsed(prev, v.time, period)).padStart(8)}` +
        `  ${durationText(elapsed(start, v.time, period)).padStart(8)}` +
        (v.count > 1 ? `  (${v.count}×)` : '')
      ).trimEnd()
    );
    prev = v.time;
  });
  lines.push(
    '',
    `  Finish   ${clockText(finish)}` +
      (finish !== null ? `  split ${durationText(elapsed(prev, finish, period))}` : '') +
      (finish !== null && start !== null
        ? `  total ${durationText(elapsed(start, finish, period))}`
        : ''),
    `  ${e.punch_count} punches, ${visits.length} controls`,
    ''
  );
  return lines.join('\n') + '\n';
};

/** Render one event as human-readable text (always ends in '\n'). */
export const formatEvent = (e: NdjsonEvent): string => {
  const at = wallClock(e.ts_ms);
  switch (e.event) {
    case 'connection_changed':
      return `${at}  reader ${e.device_path}: ${e.state}${e.error ? ` (${e.error})` : ''}\n`;
    case 'card_inserted':
      return `${at}  card ${e.card_number} (${e.card_type}) inserted, reading…\n`;
    case 'card_read':
      return formatCardRead(e);
    case 'card_removed':
      return `${at}  card ${e.card_number} removed\n\n`;
    case 'card_unsupported':
      return `${at}  card ${e.card_number} is not a supported card type, not read\n`;
    case 'frame_error':
      return `${at}  frame error: ${e.error_code}\n`;
  }
};
