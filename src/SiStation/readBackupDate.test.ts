// Authored for lool. Not ported from upstream.
//
// Date and time decoding of backup records (extended-protocol layout,
// SPORTident PC Programmer's Guide 5, backup memory data format):
//   SI2 SI1 SI0 DATE1 DATE0 TH TL MS
// The records are synthetic bytes except where noted.

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { parseBackupBlock, parseBackupDataFrame } from './readBackup.ts';

const CARD = [0x1a, 0x22, 0xe1]; // 1712865, as in the hardware fixture

/** Build one 8-byte record from calendar fields. year is 0-63 (2000+). */
function rec(year: number, month: number, day: number, pm: boolean, secs: number, ms: number) {
  const date1 = (year << 2) | (month >> 2);
  const date0 = ((month & 3) << 6) | (day << 1) | (pm ? 1 : 0);
  return [...CARD, date1, date0, secs >> 8, secs & 0xff, ms];
}

function parse(...records: number[][]) {
  return parseBackupBlock(new Uint8Array(records.flat()), 8);
}

describe('backup record date and time', () => {
  test('hardware fixture marker 0x69 0x69 is 2026-05-20, pm', () => {
    const [r] = parse([...CARD, 0x69, 0x69, 0x54, 0x37, 0x54]);
    assert.equal(r!.year, 2026);
    assert.equal(r!.month, 5);
    assert.equal(r!.day, 20);
    assert.equal(r!.halfDay, 'pm');
    assert.equal(r!.secondsInHalfDay, 0x5437);
    assert.equal(r!.subSecond, 0x54);
    assert.equal(r!.rawTime, 0x543754);
    assert.equal(r!.dateTime, '2026-05-20T17:59:19.328');
  });

  test('noon: 11:59:59.996 am then 12:00:01 pm; rawTime goes backwards', () => {
    const [a, b] = parse(rec(26, 5, 20, false, 43199, 255), rec(26, 5, 20, true, 1, 0));
    assert.equal(a!.dateTime, '2026-05-20T11:59:59.996');
    assert.equal(b!.dateTime, '2026-05-20T12:00:01.000');
    assert.equal(a!.rawTime, 11059199);
    assert.equal(b!.rawTime, 256);
    assert.ok(b!.rawTime < a!.rawTime);
    assert.ok(a!.dateTime! < b!.dateTime!);
    assert.ok(a!.secondsSinceMidnight! < b!.secondsSinceMidnight!);
  });

  test('midnight: 23:59:59.500 pm then next day 00:00:00.250 am', () => {
    const [a, b] = parse(rec(26, 5, 20, true, 43199, 128), rec(26, 5, 21, false, 0, 64));
    assert.equal(a!.dateTime, '2026-05-20T23:59:59.500');
    assert.equal(b!.dateTime, '2026-05-21T00:00:00.250');
    assert.equal(a!.secondsSinceMidnight, 86399);
    assert.equal(b!.secondsSinceMidnight, 0);
    assert.ok(a!.dateTime! < b!.dateTime!);
  });

  test('Feb 28 to Mar 1 2026 and Dec 31 2026 to Jan 1 2027', () => {
    const [a, b, c, d] = parse(
      rec(26, 2, 28, true, 43199, 0),
      rec(26, 3, 1, false, 5, 0),
      rec(26, 12, 31, true, 43199, 0),
      rec(27, 1, 1, false, 0, 0)
    );
    assert.equal(a!.dateTime, '2026-02-28T23:59:59.000');
    assert.equal(b!.dateTime, '2026-03-01T00:00:05.000');
    assert.equal(c!.dateTime, '2026-12-31T23:59:59.000');
    assert.equal(d!.dateTime, '2027-01-01T00:00:00.000');
    assert.equal(d!.year, 2027);
    assert.equal(d!.month, 1);
  });

  test('subsecond 128 is .500 and 255 is .996', () => {
    const [a, b] = parse(rec(26, 5, 20, false, 10, 128), rec(26, 5, 20, false, 10, 255));
    assert.equal(a!.dateTime, '2026-05-20T00:00:10.500');
    assert.equal(b!.dateTime, '2026-05-20T00:00:10.996');
  });

  test('invalid dates do not throw and give null date fields', () => {
    const bad = [
      rec(26, 0, 20, false, 1, 0), // month 0
      rec(26, 13, 20, false, 1, 0), // month 13
      rec(26, 5, 0, false, 1, 0), // day 0
      rec(26, 2, 30, false, 1, 0), // Feb 30
      rec(26, 2, 29, false, 1, 0), // 2026 is not a leap year
    ];
    for (const r of parse(...bad)) {
      assert.equal(r.cardNumber, 1712865);
      assert.equal(r.year, null);
      assert.equal(r.month, null);
      assert.equal(r.day, null);
      assert.equal(r.dateTime, null);
      assert.equal(r.secondsSinceMidnight, null);
      assert.equal(r.secondsInHalfDay, 1);
    }
    assert.equal(parse(rec(28, 2, 29, false, 1, 0))[0]!.dateTime, '2028-02-29T00:00:01.000');
  });

  test('seconds beyond a half day are not a valid time', () => {
    const [r] = parse(rec(26, 5, 20, false, 43200, 0));
    assert.equal(r!.dateTime, null);
  });

  test('parseBackupDataFrame carries the decoded fields', () => {
    const frame = [0x81, 0x0d, 0, 2, 0, 1, 0, ...rec(26, 5, 20, true, 1, 0)];
    assert.equal(parseBackupDataFrame(frame)[0]!.dateTime, '2026-05-20T12:00:01.000');
  });
});
