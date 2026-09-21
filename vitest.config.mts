import * as path from "node:path";
import { defineConfig } from "vitest/config";

const root = import.meta.dirname;

/** Long enough for a real `nix develop` or a server download; unit tests get the short one. */
const E2E_TIMEOUT_MS = 20 * 60 * 1000;

export default defineConfig({
  resolve: {
    // `vscode` only exists inside the editor, so everything under test resolves it to a stub.
    alias: { vscode: path.join(root, "test/activation-stub.ts") },
  },
  define: {
    // `src/utils/pty.ts` ships as a CJS bundle and reads `__filename` to build a
    // `createRequire`. Vitest serves modules as ESM, where that identifier does not exist,
    // so point it at the source file the bundle is built from -- the require it creates
    // only ever resolves absolute paths, so the base matters for nothing but existing.
    __filename: JSON.stringify(path.join(root, "src/utils/pty.ts")),
  },
  test: {
    // Declared here because `strictTags` is on by default: a tag a file uses and this list
    // does not name is an error rather than a typo that quietly matches nothing.
    tags: [
      {
        name: "e2e",
        description: "builds derivations, downloads editor servers, binds ports: minutes, not seconds",
      },
    ],
    projects: [
      {
        extends: true,
        test: {
          name: "unit",
          include: ["test/**/*.test.ts"],
          exclude: ["test/**/*.e2e.test.ts"],
          testTimeout: 30_000,
        },
      },
      {
        extends: true,
        test: {
          name: "e2e",
          include: ["test/**/*.e2e.test.ts"],
          testTimeout: E2E_TIMEOUT_MS,
          hookTimeout: E2E_TIMEOUT_MS,
          // These build derivations, download servers and bind ports; one at a time.
          fileParallelism: false,
        },
      },
    ],
  },
});
