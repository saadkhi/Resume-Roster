import js from '@eslint/js';

const nodeGlobals = {
  process: 'readonly', console: 'readonly', Buffer: 'readonly', URL: 'readonly', URLSearchParams: 'readonly',
  fetch: 'readonly', FormData: 'readonly', Blob: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly',
  globalThis: 'readonly', __dirname: 'readonly', Uint8Array: 'readonly', AbortSignal: 'readonly', Response: 'readonly'
};

const browserGlobals = {
  window: 'readonly', document: 'readonly', navigator: 'readonly', fetch: 'readonly', FormData: 'readonly',
  localStorage: 'readonly', setTimeout: 'readonly', clearTimeout: 'readonly', console: 'readonly', Math: 'readonly'
};

export default [
  {
    ignores: ['node_modules/**', 'public/vendor/**', 'public/match-visualizer.bundle.js', '.data/**', 'uploads/**']
  },
  js.configs.recommended,
  {
    files: ['**/*.js', '**/*.mjs'],
    languageOptions: { ecmaVersion: 2023, sourceType: 'module', globals: nodeGlobals },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-var': 'error',
      'prefer-const': 'error'
    }
  },
  {
    // Browser scripts are classic (non-module) IIFEs and intentionally use `var`.
    files: ['public/js/**/*.js'],
    languageOptions: { ecmaVersion: 2020, sourceType: 'script', globals: browserGlobals },
    rules: { 'no-var': 'off', 'prefer-const': 'off' }
  }
];
