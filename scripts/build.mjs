/** Build step: bundles the radar chart and regenerates the sample PDFs. */
import path from 'path';
import { fileURLToPath } from 'url';
import { build } from 'esbuild';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const p = (...parts) => path.join(root, ...parts);

await build({
  entryPoints: [p('src', 'MatchVisualizer.jsx')],
  bundle: true,
  minify: true,
  format: 'iife',
  target: ['es2019'],
  define: { 'process.env.NODE_ENV': '"production"' },
  outfile: p('public', 'match-visualizer.bundle.js'),
  logLevel: 'info'
});

await import('./create-sample-resumes.js');
