# Third-party software

This package (`@lool-ing/sportident`) is MIT-licensed (see `LICENSE`). It
contains code ported from upstream MIT projects and references reference
implementations under other licenses for verification only. Per-file MIT
NOTICE headers in `src/` carry line-level attribution; this document is
the package-level summary.

## allestuetsmerweh/sportident.js

- **Repository:** <https://github.com/allestuetsmerweh/sportident.js>
- **License:** MIT
  (<https://github.com/allestuetsmerweh/sportident.js/blob/master/LICENSE>)
- **Scope of port:** Protocol primitives (`siProtocol`, `constants`,
  `utils/bytes`, `utils/general`, the `storage/` primitives), card
  decoders (`BaseSiCard`, `ModernSiCard`, `SiCard5`, `SiCard6`, `SiCard8`,
  `SiCard9`, `SiCard10`, `SiCard11`, `SIAC`, `IRaceResultData`, `ISiCard`,
  `ISiCardExamples`), station code (`ISiStation`, `ISiMainStation`,
  `SiSendTask`; simplified: `BaseSiStation`, `SiMainStation`; heavily
  simplified: `SiTargetMultiplexer`), `siProtocol.test.ts`, and test data
  in `tests/fixtures/upstream/` and the SiCard6/SiCard8 tests. See the
  per-file headers in `src/` for line-level attribution and
  `scripts/check-mit-attribution.sh` for the automated audit.

### Upstream licence text

MIT License

Copyright (c) 2018 Simon Hatt

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## per-magnusson/sportident-python

- **Repository:** <https://github.com/per-magnusson/sportident-python>
- **License:** GPL
- **Scope:** Reference only — **no code copied**. Credited here for CRC
  cross-verification (the canonical SI CRC test vectors are tabulated in
  that project's README).

## sdenier/GecoSI

- **Repository:** <https://github.com/sdenier/GecoSI>
- **License:** see the upstream repository
- **Scope:** Reference only — **no code copied**. Credited for handshake
  protocol cross-reading.
