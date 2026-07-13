import { defineConfig } from "vite";

export default defineConfig({
  root: ".",
  base: "./",
  build: {
    outDir: "dist/renderer",
    emptyOutDir: true,
    rollupOptions: {
      input: "index.html"
    }
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: false
  }
});
