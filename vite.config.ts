import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [vue()],
  // 避免 App.vue 里 examples/jsm 与 Viewer 各打一份 three，导致 TransformControls 不是 scene 用的那份 Object3D
  resolve: {
    dedupe: ['three'],
  },
  optimizeDeps: {
    include: ['three'],
  },
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

