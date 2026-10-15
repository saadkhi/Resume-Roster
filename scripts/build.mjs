/**
 * Build step: bundles the radar chart, vendors the Supabase browser client
 * (so no third-party script origin is needed) and regenerates sample PDFs.
 */
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

const supabaseUmd = p('node_modules', '@supabase', 'supabase-js', 'dist', 'umd', 'supabase.js');
if (fs.existsSync(supabaseUmd)) {
  fs.mkdirSync(p('public', 'vendor'), { recursive: true });
  fs.copyFileSync(supabaseUmd, p('public', 'vendor', 'supabase.js'));
  console.log('Vendored @supabase/supabase-js -> public/vendor/supabase.js');
} else {
  console.warn('Notice: @supabase/supabase-js UMD build not found; skipping vendor copy.');
}

await import('./create-sample-resumes.js');
