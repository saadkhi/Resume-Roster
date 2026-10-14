// ESLint flat config (ESLint 9+, ESM project)
export default [
  {
    // Only lint application source — not generated bundles, test fixtures, or data
    files: ['server.js', 'src/**/*.js', 'api/**/*.js'],
    ignores: ['node_modules/**', 'public/**', 'data/**', 'uploads/**'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        // Node.js globals
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        __dirname: 'readonly',
        __filename: 'readonly',
        globalThis: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        URL: 'readonly',
      }
    },
    rules: {
      // Errors — things that are always bugs
      'no-undef': 'error',
      'no-unused-vars': ['error', { vars: 'all', args: 'after-used', ignoreRestSiblings: true, argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-unreachable': 'error',
      'no-constant-condition': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-self-assign': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'error',

      // Warnings — code quality
      'no-console': 'off',          // server-side logging is intentional
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
      'no-var': 'warn',
      'prefer-const': ['warn', { destructuring: 'all' }],
      'no-eval': 'error',
      'no-implied-eval': 'error',
    }
  }
];
