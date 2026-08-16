import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // three/webgpu uses top-level await; the default esbuild target
    // (chrome87/es2020/etc.) doesn't support it, so builds fail without this.
    target: 'esnext',
  },
  esbuild: {
    target: 'esnext',
  },
});
