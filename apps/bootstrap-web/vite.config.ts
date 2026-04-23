import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@starkeep/admin-core": path.resolve(__dirname, "../../packages/admin-core/src/index.ts"),
    },
  },
  build: { outDir: "dist" },
});
