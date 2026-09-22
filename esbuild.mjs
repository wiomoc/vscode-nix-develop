import * as esbuild from "esbuild";
import { rm } from "node:fs/promises";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

// A stale sourcemap from a previous non-production build would otherwise be packaged.
await rm("dist", { recursive: true, force: true });

const common = {
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  minify: production,
  sourcemap: !production,
  logLevel: "info",
};

/**
 * Two bundles, because two processes.
 *
 * `extension.js` is loaded by the editor's extension host, where `vscode` is supplied by
 * the runtime and so is left external. `provision.js` is run by the *server's* `node`,
 * inside `nix develop`, where there is no such module -- which is why nothing under
 * `src/provision` may import it, and why this entry point declares nothing external: what
 * it needs, it carries.
 */
const targets = [
  { entryPoints: ["src/extension.ts"], outfile: "dist/extension.js", external: ["vscode"] },
  { entryPoints: ["src/provision/main.ts"], outfile: "dist/provision.js" },
];

const contexts = await Promise.all(
  targets.map((target) => esbuild.context({ ...common, ...target })),
);

if (watch) {
  await Promise.all(contexts.map((ctx) => ctx.watch()));
} else {
  await Promise.all(contexts.map((ctx) => ctx.rebuild()));
  await Promise.all(contexts.map((ctx) => ctx.dispose()));
}
