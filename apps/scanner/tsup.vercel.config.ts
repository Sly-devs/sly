import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['api/index.ts'],
  // CJS — undici and other Node-native libs use dynamic require() internally,
  // which breaks when bundled as ESM ("Dynamic require of X is not supported").
  format: ['cjs'],
  platform: 'node',
  target: 'node20',
  splitting: false,
  clean: true,
  // Bundle everything so the function directory is self-contained.
  noExternal: [/./],
});
