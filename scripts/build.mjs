/** Build step: bundles the radar chart and regenerates the sample PDFs. */
import fs from 'fs';
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

// Vendor the liquid-glass library (MIT, no runtime dependencies) so no third-party script origin is needed.
const glassSrc = p('node_modules', 'liquid-gl', 'liquidGL.js');
if (fs.existsSync(glassSrc)) {
  fs.mkdirSync(p('public', 'vendor'), { recursive: true });
  fs.copyFileSync(glassSrc, p('public', 'vendor', 'liquidGL.js'));
  console.log('Vendored liquid-gl -> public/vendor/liquidGL.js');
}

await import('./create-sample-resumes.js');
