import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
export default defineConfig(({ command }) => ({ base: command === 'build' ? '/cloud-collection/' : '/', plugins: [react()], cacheDir: '.cache/vite', server: { port: 5173, strictPort: true, watch: { ignored: ['**/.cache/**','**/.temp/**','**/.tools/**','**/tests/artifacts/**','**/*.sog'] } }, build: { outDir: 'dist', chunkSizeWarningLimit: 1800, rollupOptions: { output: { manualChunks: { playcanvas: ['playcanvas','@playcanvas/react'] } } } } }));
