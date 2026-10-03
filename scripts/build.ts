import { mkdir, copyFile } from 'node:fs/promises';
import { build } from 'esbuild';

await mkdir('public', { recursive: true });
await build({ entryPoints: ['src/web/app.ts'], outfile: 'public/app.js', bundle: true,
  minify: true, format: 'esm', platform: 'browser', target: 'es2022', legalComments: 'eof' });
await copyFile('src/web/app.css', 'public/app.css');
console.log('Built self-contained setup assets. No CDN requests.');
