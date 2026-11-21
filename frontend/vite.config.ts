import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: Vite serves the UI on :5173 and forwards API + WebSocket traffic to the FastAPI backend on :8000.
// Build: output goes to dist/, which FastAPI serves in production.
const BACKEND = "http://127.0.0.1:8000";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 5173,
    proxy: {
      "/api": { target: BACKEND, changeOrigin: true },
      "/ws": { target: BACKEND, ws: true, changeOrigin: true },
    },
  },
  build: { outDir: "dist", sourcemap: true },
});
