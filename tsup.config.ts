import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts', 'src/bin/lool-readout.ts', 'src/bin/lool-trainer.ts'],
  format: ['esm', 'cjs'],
  // TypeScript 6 deprecates baseUrl, and tsup 8.5.1 (the last release)
  // always injects baseUrl into its dts build. Scoped to tsup only;
  // typecheck still reports deprecations.
  dts: { compilerOptions: { ignoreDeprecations: '6.0' } },
  sourcemap: true,
  clean: true,
  target: 'node26',
  splitting: false,
  outDir: 'dist',
  // outExtension: explicit .mjs/.cjs so package.json bin and
  // exports paths resolve to actual files on disk. Shebang handling for the bin entry
  // may extend this later, but the extension contract is locked here.
  outExtension({ format }) {
    return { js: format === 'esm' ? '.mjs' : '.cjs' };
  },
  // IN-001: the CJS bundle parses `import.meta.url`
  // (from the createRequire shim in SerialTransport.ts) but doesn't reach it at
  // runtime — the fix guards via `typeof import.meta`. esbuild warns
  // anyway. Silence only this specific warning so genuine future warnings stay
  // visible.
  esbuildOptions(options) {
    options.logOverride = {
      ...options.logOverride,
      'empty-import-meta': 'silent',
    };
  },
});
