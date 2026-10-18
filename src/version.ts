// Authored for lool. Not ported from upstream.
//
// The package version, read from package.json so it cannot drift. tsup
// inlines the JSON into the bundle.

import pkg from '../package.json' with { type: 'json' };

export const VERSION: string = pkg.version;
