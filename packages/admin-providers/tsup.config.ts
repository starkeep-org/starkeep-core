import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/aws/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  sourcemap: true,
  external: [
    "@aws-sdk/client-cloudformation",
    "@aws-sdk/client-s3",
    "@aws-sdk/client-sts",
    "@aws-sdk/credential-providers",
  ],
});
