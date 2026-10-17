// Authored for lool. Not ported from upstream.
// One-line ISO-prefixed stderr diagnostic emitter for operator visibility.
//
// Stdout is reserved for pure NDJSON. Diagnostics (CRC failures,
// transport errors, fatal messages) go here so a human operator running the
// bin in a terminal sees them without piping stdout through a JSON parser.
//
// See NOTICE.md for cumulative attribution.

/**
 * Write a single line of human-readable diagnostic text to stderr.
 *
 * Output format: `[<ISO timestamp>] <line>\n`. Always one line per call,
 * always ending in exactly one '\n'.
 *
 * `err` defaults to `process.stderr.write` (bound); tests inject a capture
 * array via the second argument.
 */
export const emitDiagnostic = (
  line: string,
  err: (s: string) => void = (s) => {
    process.stderr.write(s);
  }
): void => {
  const ts = new Date().toISOString();
  err(`[${ts}] ${line}\n`);
};
