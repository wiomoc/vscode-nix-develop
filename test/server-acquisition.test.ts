import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import * as cp from "node:child_process";
import { afterAll, describe, expect, it } from "vitest";
import type { NixDevShellConfig } from "../src/config";
import { ServerManager, serverPlatform } from "../src/remote/server";
import { forgetProduct } from "../src/remote/product";
import * as stub from "./activation-stub";

const cfg: NixDevShellConfig = {
  flakeDirectory: ".",
  promptWhenUnset: true,
  impure: false,
  extraArgs: [],
  nixPath: "nix",
  buildTimeoutSeconds: 1800,
  profile: "persistent",
  showBuildOutput: "onFailure",
  remote: {
    serverDownloadUrl: "https://example.invalid/${commit}/${platform}",
    connectTimeoutSeconds: 180,
    patchServerLd: true,
  },
};

/**
 * Acquiring a server end to end, against a local HTTP server. Catches e.g. swapped
 * arguments to `serverDownloadUrl(commit, configured)`, which would still typecheck.
 */

const root = await fs.mkdtemp(path.join(os.tmpdir(), "nd-acquire-"));
const commit = "1a46a584725d5dd330e0bcd7f5510f24990efcf2";

// A distribution shaped the way VSCodium ships one: no wrapper directory, and a launcher
// named after the product rather than `code-server`.
const dist = path.join(root, "dist");
await fs.mkdir(path.join(dist, "bin"), { recursive: true });
await fs.writeFile(
  path.join(dist, "product.json"),
  JSON.stringify({ serverApplicationName: "codium-server", commit }),
);
await fs.writeFile(path.join(dist, "bin", "codium-server"), "#!/bin/sh\n", { mode: 0o755 });
const tarball = path.join(root, "dist.tar.gz");
cp.execFileSync("tar", ["-czf", tarball, "-C", dist, "."]);
const bytes = await fs.readFile(tarball);

// The editor that is running, as far as the extension can tell.
const appRoot = path.join(root, "app");
await fs.mkdir(appRoot, { recursive: true });
await fs.writeFile(
  path.join(appRoot, "product.json"),
  JSON.stringify({
    nameLong: "VSCodium",
    quality: "stable",
    serverApplicationName: "codium-server",
    serverDataFolderName: ".vscodium-server",
    dataFolderName: ".vscode-oss",
  }),
);

let asked = "";
const server = http.createServer((req, res) => {
  asked = req.url ?? "";
  res.writeHead(200, { "content-type": "application/gzip" });
  res.end(bytes);
});
const port = await new Promise<number>((resolve) => {
  server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port));
});

const previousAppRoot = stub.env.appRoot;
stub.env.appRoot = appRoot;
forgetProduct();

describe("server acquisition", () => {
  const storage = path.join(root, "storage");
  const acquireCfg: NixDevShellConfig = {
    ...cfg,
    remote: {
      ...cfg.remote,
      serverDownloadUrl: `http://127.0.0.1:${port}/\${commit}/server-\${platform}.tar.gz`,
    },
  };
  const manager = new ServerManager({ fsPath: storage } as never, acquireCfg);
  let launcher = "";

  afterAll(async () => {
    stub.env.appRoot = previousAppRoot;
    forgetProduct();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await fs.rm(root, { recursive: true, force: true });
  });

  it("downloads from the URL the commit and platform belong in", async () => {
    launcher = await manager.ensureServer(commit);
    expect(asked, "the request went somewhere else").toEqual(`/${commit}/server-${serverPlatform()}.tar.gz`);
  });

  it("finds a launcher named after the product, not code-server", async () => {
    expect(path.basename(launcher)).toEqual("codium-server");
    expect(await fs.lstat(launcher).then(() => true).catch(() => false), `${launcher} is missing`).toBe(true);
  });

  it("unwraps a flat archive without losing the distribution", async () => {
    const dir = path.dirname(path.dirname(launcher));
    const entries = (await fs.readdir(dir)).sort();
    expect(entries, "the distribution should sit at the top of the dir").toEqual(["bin", "product.json"]);
  });

  it("a second acquisition reuses what is on disk", async () => {
    asked = "";
    expect(await manager.ensureServer(commit)).toEqual(launcher);
    expect(asked, "nothing should have been downloaded again").toEqual("");
  });
});
