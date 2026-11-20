import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/coverage/**',
      '**/.wrangler/**',
      'packages/mobile-app/android/**',
      // Versioned upstream production artifacts are kept byte-for-byte.
      'packages/mobile-app/public/google2-adapter.js',
      'packages/mobile-app/public/assets/tailwind/**',
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
);
