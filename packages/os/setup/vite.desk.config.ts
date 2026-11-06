import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  root: here,
  base: "./",
  server: {
    host: "0.0.0.0",
    port: 5176,
    strictPort: true,
    fs: {
      allow: [path.resolve(here, "../../..")],
    },
  },
  build: {
    outDir: path.resolve(here, "dist-valhalla-desk"),
    emptyOutDir: true,
    rollupOptions: {
      input: path.resolve(here, "desk.html"),
    },
  },
});
