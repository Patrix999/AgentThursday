import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    // Allow imports from web/shared/schema.ts → ../../src/schema ( re-export).
    fs: { allow: [".."] },
    proxy: {
      "/api": "http://localhost:8787",
      "/cli": "http://localhost:8787",
      "/health": "http://localhost:8787",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    rollupOptions: {
      output: {
        // §D-8: split react / router into a vendor chunk so the app
        // entry stays small and is downloaded fresh on each deploy.
        manualChunks: {
          vendor: ["react", "react-dom", "react-router-dom"],
        },
      },
    },
  },
});
