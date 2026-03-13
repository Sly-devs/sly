import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    x402: 'src/protocols/x402/index.ts',
    ap2: 'src/protocols/ap2/index.ts',
    acp: 'src/protocols/acp/index.ts',
    ucp: 'src/protocols/ucp/index.ts',
    langchain: 'src/langchain/index.ts',
    vercel: 'src/vercel/index.ts',
    cards: 'src/cards/index.ts',
    a2a: 'src/protocols/a2a/index.ts',
  },
  format: ['cjs', 'esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  treeshake: true,
  splitting: false,
  minify: false,
  external: ['express'],
  outDir: 'dist',
});

