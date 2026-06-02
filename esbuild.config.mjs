import * as esbuild from 'esbuild';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));

const common = {
  bundle: true,
  minify: false,
  sourcemap: true,
  target: ['chrome120'],
  logLevel: 'info',
};

// Bundle renderer (app.ts → app.js)
await esbuild.build({
  ...common,
  entryPoints: [join(__dirname, 'app.ts')],
  outfile: join(__dirname, 'app.js'),
  format: 'iife',
  platform: 'browser',
});

// Bundle preload (preload.ts → preload.js)
await esbuild.build({
  ...common,
  entryPoints: [join(__dirname, 'preload.ts')],
  outfile: join(__dirname, 'preload.js'),
  format: 'cjs',
  platform: 'node',
  external: ['electron'],
});

console.log('✅ Build complete: app.js + preload.js');
