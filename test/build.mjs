import * as esbuild from "esbuild";

// `vscode` only exists inside the editor, so tests bundle against a stub.
await esbuild.build({
  entryPoints: ["test/index.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "out/test.cjs",
  alias: { vscode: "./test/activation-stub.ts" },
  logLevel: "warning",
});
