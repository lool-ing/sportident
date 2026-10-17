// Authored for lool. Not ported from upstream.
//
// `RecordSink` — extends `NdjsonEmitter` to tee captured NDJSON events to
// `<basename>.expected.json` AND a DIRECTIONAL wire transcript to
// `<basename>.bytes.hex` (`out <hex>` per transport send; `in <hex>` per
// transport receive).
//
// Path validation: `recordBasename` is resolved to
// an absolute path and rejected synchronously (before any stream open) if it
// resolves outside any of the configured `allowedRoots`. Defaults to
// `[process.cwd()]`; bin and tests pass `[process.cwd(), '/tmp']` so
// `/tmp/lool-*` fixtures during tests stay permitted.
//
// See NOTICE.md for cumulative attribution.

import * as fs from 'node:fs';
import * as path from 'node:path';

import { NdjsonEmitter, type NdjsonEmitterOpts } from '../output/ndjson.ts';

export interface RecordSinkOpts extends NdjsonEmitterOpts {
  /** Basename for the two output files. The sink writes `<basename>.bytes.hex`
   * (directional wire transcript) and `<basename>.expected.json` (NDJSON). */
  recordBasename: string;
  /** Roots under which `recordBasename` is permitted to resolve. Default:
   * `[process.cwd()]`. The bin passes `[process.cwd(), '/tmp']` so tests can
   * write to /tmp. */
  allowedRoots?: string[];
}

const hexEncode = (bytes: number[]): string =>
  bytes.map((b) => b.toString(16).padStart(2, '0').toUpperCase()).join(' ');

/** Resolve allowedRoots to absolutes and validate that `recordBasename` lives
 * inside ANY of them. Throws synchronously on violation. */
const validateBasename = (recordBasename: string, allowedRoots: string[]): string => {
  const resolved = path.resolve(recordBasename);
  const roots = allowedRoots.map((r) => path.resolve(r));
  const ok = roots.some((root) => {
    // Allow the basename itself to be the root (degenerate) OR be a child of
    // the root. The +path.sep check guards against `/tmp-other` matching `/tmp`
    // as a prefix.
    return resolved === root || resolved.startsWith(root + path.sep);
  });
  if (!ok) {
    throw new Error(
      `recordBasename resolves outside allowed roots: ${resolved} (allowed: ${roots.join(', ')})`
    );
  }
  return resolved;
};

export class RecordSink extends NdjsonEmitter {
  private readonly resolvedBasename: string;
  private readonly bytesStream: fs.WriteStream;
  private readonly expectedStream: fs.WriteStream;
  private closed = false;

  constructor(opts: RecordSinkOpts) {
    // Validate BEFORE opening any stream.
    const allowedRoots = opts.allowedRoots ?? [process.cwd()];
    const resolved = validateBasename(opts.recordBasename, allowedRoots);

    // Build the parent NdjsonEmitter so it tees expected.json AND stdout. The
    // operator running `lool-readout --record` still wants to see live NDJSON
    // on stdout, so we keep the stdout default and pipe a *separate* write into
    // expected.json via a wrapper around `out`.
    const expectedStream = fs.createWriteStream(`${resolved}.expected.json`, { flags: 'w' });
    const userOut = opts.out ?? ((line: string) => process.stdout.write(line));
    const teedOut = (line: string): void => {
      userOut(line);
      expectedStream.write(line);
    };
    const innerOpts: NdjsonEmitterOpts = {
      device_path: opts.device_path,
      out: teedOut,
    };
    if (opts.device_serial !== undefined) innerOpts.device_serial = opts.device_serial;
    if (opts.includeRawPages !== undefined) innerOpts.includeRawPages = opts.includeRawPages;
    super(innerOpts);
    this.resolvedBasename = resolved;
    this.expectedStream = expectedStream;

    // Open bytes.hex with the directional-transcript header.
    this.bytesStream = fs.createWriteStream(`${resolved}.bytes.hex`, { flags: 'w' });
    this.bytesStream.write(`# Captured ${new Date().toISOString()} from ${opts.device_path}\n`);
    this.bytesStream.write(`# device_serial: ${opts.device_serial ?? 'unknown'}\n`);
    this.bytesStream.write(
      `# Format: directional transcript ('out <hex>' for sends, 'in <hex>' for receives), chronological.\n`
    );
  }

  /** Record a wire send: directional transcript line of the
   * form 'out <hex>\n' (literal prefix). */
  onRawSend(bytes: number[]): void {
    if (this.closed) return;
    this.bytesStream.write('out ' + hexEncode(bytes) + '\n');
  }

  /** Record a wire receive: directional transcript line of
   * the form 'in <hex>\n' (literal prefix). */
  onRawReceive(bytes: number[]): void {
    if (this.closed) return;
    this.bytesStream.write('in ' + hexEncode(bytes) + '\n');
  }

  /** Public for tests / docs — the resolved absolute basename. */
  get basename(): string {
    return this.resolvedBasename;
  }

  /** Flush both write streams and end them. Idempotent. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all([
      new Promise<void>((resolve) => this.bytesStream.end(() => resolve())),
      new Promise<void>((resolve) => this.expectedStream.end(() => resolve())),
    ]);
  }
}
