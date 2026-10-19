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
- Releases follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html)
  and [Keep a Changelog](https://keepachangelog.com/en/1.1.0/); see
  "Releasing" below. The first publish with provenance needs the GitHub
  repository to be public.

## Releasing

The version and `CHANGELOG.md` come from the Conventional Commits on `main`
(git-cliff, `cliff.toml`). `feat` bumps the minor, `fix` and `perf` the
patch; while the major is 0 a breaking change bumps the minor, from 1.0.0
the major. `docs`, `test`, `chore`, `ci`, `build` and `style` stay out of
the changelog.

A change to what a decoder outputs is a `fix:` (or `feat:`), so it bumps the
next release's version; the version is set at release, not per commit.
Between releases the package reports the last release's version. Consumers
that store the version with each read, to find reads from a buggy decoder,
use a release from npm, not a git-linked build.

1. On a branch from `main`: `pnpm release:version` prints the next version.
2. `pnpm changelog` adds that version's section at the top of
   `CHANGELOG.md`. Rewrite it for users: merge fix-of-a-fix entries, say
   what changed for consumers (NDJSON fields, events, behaviour), use
   Deprecated / Security where they apply, and add the version's link at
   the bottom (`[x.y.z]: https://github.com/lool-ing/sportident/compare/vA...vB`).
3. Set `version` in `package.json` to the same version.
4. Open a PR `chore(release): x.y.z`. After it is merged, tag the merge
   commit `vx.y.z` and push the tag: the publish workflow builds, tests
   and publishes to npm.

## Rules that are easy to break

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
