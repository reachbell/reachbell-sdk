import typescript from '@rollup/plugin-typescript';
import { copyFileSync } from 'node:fs';

/**
 * One declaration file per module condition. A single ESM-syntax index.d.ts
 * shared by `import` and `require` makes TypeScript (node16/nodenext) treat
 * the CJS entry as ESM-typed. The content is identical: the CJS bundle uses
 * `exports: 'named'`, so `export default` maps to `require(...).default`,
 * which is exactly what an ESM-syntax .d.cts describes.
 */
const perConditionTypes = () => ({
  name: 'per-condition-types',
  writeBundle: { sequential: true, order: 'post', handler() {
    copyFileSync('dist/index.d.ts', 'dist/index.d.mts');
    copyFileSync('dist/index.d.ts', 'dist/index.d.cts');
  } },
});

/**
 * Three-format build:
 *   dist/index.cjs      — CommonJS (Node require, older bundlers)
 *   dist/index.mjs      — ES module (modern Node, Vite, esbuild, Rollup)
 *   dist/index.iife.js  — IIFE with global `window.ReachBell` for direct
 *                         <script> use. Required by the WordPress plugin
 *                         which can't import an ESM/CJS bundle from a
 *                         wp_enqueue_script() tag.
 *
 * All three formats import the SAME source. Tree-shaking is signalled via
 * the `sideEffects` array in package.json — the only side effect is the
 * `window.ReachBell = ReachBell` global at the end of src/index.ts.
 */
export default {
  input: 'src/index.ts',
  output: [
    // `exports: 'named'` on every format — the source ships named
    // exports (escapeHtml, safeColor, ReachBell, …) alongside a default
    // export (also ReachBell). Without this Rollup warns about the
    // mixed pattern, and CJS consumers reach the default via
    // `require('@reachbell/sdk').default` — the correct behavior, we
    // just opt in explicitly.
    { file: 'dist/index.cjs',     format: 'cjs',  sourcemap: true, exports: 'named' },
    { file: 'dist/index.mjs',     format: 'esm',  sourcemap: true, exports: 'named' },
    { file: 'dist/index.iife.js', format: 'iife', sourcemap: true, name: 'ReachBellBundle', exports: 'named' },
  ],
  plugins: [
    typescript({
      tsconfig: './tsconfig.json',
      // Rollup handles bundling; let TS just emit the types alongside.
      declaration: true,
      declarationDir: 'dist',
      rootDir: 'src',
      sourceMap: true,
    }),
    perConditionTypes(),
  ],
};
