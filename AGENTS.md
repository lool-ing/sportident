# Working on @lool-ing/sportident

Instructions for anyone changing this repo: people and AI coding agents
(Claude Code reads `CLAUDE.md`, which points here).

## How we work

- **Minimum code that solves the stated problem.** Stay in scope; match
  the style of the surrounding code.
- **Verifiable goals.** A bug fix comes with a test that reproduces it.
  A decoder change comes with a fixture: a recorded transcript under
  `tests/fixtures/bench/` (`lool-readout --record`) or synthetic bytes
  under `tests/fixtures/synthetic/`.

## Checks before you commit

```bash
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

`pnpm lint` also runs `scripts/check-mit-attribution.sh`, which checks
the file headers below.

## Commits and pull requests

- **Conventional Commits**, checked by commitlint: `feat:`, `fix:`,
  `docs:`, `test:`, `refactor:`, `chore:`, `perf:`, `build:`, `ci:`.
  Imperative, lowercase after the colon, about 70 characters, no full
  stop. Body only when the why isn't obvious.
- One task, one commit. Open a PR to `main`.
- A release is a version bump in `package.json` and a tag `v<version>`;
  the publish workflow does the rest. The first publish with provenance
  needs the GitHub repository to be public.

## Rules that are easy to break

- **Decoding changes bump the version.** Any change to what a decoder
  outputs bumps `version` in `package.json` (patch at least): consumers
  store `VERSION` with every read to find the reads made by a buggy
  decoder.
- **File headers.** A new file starts with
  `// Authored for lool. Not ported from upstream.`, or, when it is
  ported, with the header of the code it came from
  (`// Ported from allestuetsmerweh/sportident.js — <path>`).
- **Read [NOTICE.md](NOTICE.md) before porting.** Only MIT code may be
  ported. `sportident-python` and `GecoSI` are for cross-checking only;
  no code from them.
- **SPORTident's documentation is not ours to publish.** Use it for
  facts; never copy it into the repo.
- **No personal data.** Fixtures carry card numbers and punches only,
  never names or other data about the runner.
