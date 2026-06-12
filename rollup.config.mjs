import typescript from '@rollup/plugin-typescript';

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
    { file: 'dist/index.cjs',     format: 'cjs',  sourcemap: true, exports: 'named' },
    { file: 'dist/index.mjs',     format: 'esm',  sourcemap: true },
    { file: 'dist/index.iife.js', format: 'iife', sourcemap: true, name: 'ReachBellBundle' },
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
  ],
};
