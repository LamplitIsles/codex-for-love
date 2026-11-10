import { defineConfig } from "tsup";

export default defineConfig({
  clean: true,
  entry: ["src/index.ts", "src/protocol.ts"],
  experimentalDts: true,
  format: ["esm"],
  sourcemap: true,
  target: "node18",
  tsconfig: "tsconfig.build.json",
});
