import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    copyPublicDir: false,
    emptyOutDir: false,
    lib: {
      entry: 'src/index.ts',
      formats: ['es'],
      fileName: () => 'index.js',
    },
    sourcemap: true,
    rollupOptions: {
      external: ['three', /^three\//, 'gsap', 'three-mesh-bvh'],
      output: {
        preserveModules: false,
      },
    },
  },
});

