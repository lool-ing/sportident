// Authored for lool. Not ported from upstream.
//
// The package version. tsup inlines it at build time (`define` in
// tsup.config.ts); unbundled, as in the tests, it is read from package.json.

import { readFileSync } from 'node:fs';

declare const __LOOL_VERSION__: string | undefined;

export const VERSION: string =
  typeof __LOOL_VERSION__ === 'string'
    ? __LOOL_VERSION__
    : (
        JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
          version: string;
        }
      ).version;
