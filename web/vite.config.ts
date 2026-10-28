import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { resolve } from "node:path";

// In dev, proxy the API, the terminal and the screen (and their WebSockets) to the portal. The Host
// stays localhost:5173, so the portal's Origin check (Origin == Host) still holds.
// Two pages: the portal (index.html) and the guest page for shared work (share.html, served by
// server/src/shareServer.ts on its own port).
export default defineConfig({
  plugins: [react()],
  build: {
    rollupOptions: { input: { main: resolve(__dirname, "index.html"), share: resolve(__dirname, "share.html") } },
  },
  server: {
    proxy: Object.fromEntries(["/api", "/term", "/screen"].map((p) => [p, { target: "http://localhost:7700", ws: true }])),
  },
});
