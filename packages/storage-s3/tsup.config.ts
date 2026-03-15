import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@aws-sdk/client-s3",
    "@aws-sdk/s3-request-presigner",
    "@aws-sdk/lib-storage",
  ],
});
