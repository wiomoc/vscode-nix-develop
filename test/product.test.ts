import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readProduct, serverDownloadUrl, clientProduct, forgetProduct } from "../src/remote/product";
import * as stub from "./activation-stub";

/**
 * Detecting which editor is running. VSCodium values are copied from the `product.json` in
 * `vscodium-reh-linux-x64-1.135.06055.tar.gz`.
 */

const VSCODIUM = {
  nameLong: "VSCodium",
  applicationName: "codium",
  commit: "1a46a584725d5dd330e0bcd7f5510f24990efcf2",
  quality: "stable",
  serverApplicationName: "codium-server",
  serverDataFolderName: ".vscodium-server",
  dataFolderName: ".vscode-oss",
  serverDownloadUrlTemplate:
    "https://github.com/VSCodium/vscodium/releases/download/1.135.06055/" +
    "vscodium-reh-${os}-${arch}-1.135.06055.tar.gz",
};

// Microsoft's desktop build, as shipped: note the absence of a download template.
const MICROSOFT = {
  nameLong: "Visual Studio Code",
  applicationName: "code",
  commit: "1e3c50d64110be466c0b4a45222e81d2c9352888",
  quality: "stable",
  version: "1.106.2",
  serverApplicationName: "code-server",
  serverDataFolderName: ".vscode-server",
  dataFolderName: ".vscode",
};

const root = await fs.mkdtemp(path.join(os.tmpdir(), "nd-product-"));
const appRoot = async (name: string, product?: unknown): Promise<string> => {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  if (product) await fs.writeFile(path.join(dir, "product.json"), JSON.stringify(product));
  return dir;
};

describe("product detection", () => {
  it("reads VSCodium's own description of itself", async () => {
    const p = await readProduct(await appRoot("codium", VSCODIUM));
    expect(p.serverApplicationName, "the launcher is not called code-server").toEqual("codium-server");
    expect(p.serverDataFolderName).toEqual(".vscodium-server");
    expect(p.dataFolderName).toEqual(".vscode-oss");
    expect(p.nameLong).toEqual("VSCodium");
    expect(!p.serverDownloadUrlTemplate, "VSCodium points at its own release").toBe(false);
  });

  it("reads a Microsoft build, which declares no download URL", async () => {
    const p = await readProduct(await appRoot("ms", MICROSOFT));
    expect(p.serverApplicationName).toEqual("code-server");
    expect(p.serverDataFolderName).toEqual(".vscode-server");
    expect(p.serverDownloadUrlTemplate, "Microsoft keeps this in the CLI, not here").toEqual(undefined);
  });

  it("a product.json that cannot be read means a Microsoft build", async () => {
    // Being wrong about the product beats refusing to open a devShell window.
    const p = await readProduct(await appRoot("empty"));
    expect(p.serverApplicationName).toEqual("code-server");
    expect(p.serverDataFolderName).toEqual(".vscode-server");
  });

  // `serverDownloadUrl` reads the running editor's product, so these swap it in and back.
  describe("the URL the running editor implies", () => {
    const previousAppRoot = stub.env.appRoot;
    afterAll(() => {
      stub.env.appRoot = previousAppRoot;
      forgetProduct();
    });

    const running = async (name: string, product: unknown): Promise<void> => {
      stub.env.appRoot = await appRoot(name, product);
      forgetProduct();
    };

    it("VSCodium is fetched from the release its product.json names", async () => {
      await running("codium2", VSCODIUM);
      const url = await serverDownloadUrl(VSCODIUM.commit);
      // The release tag is already baked into the template; only os and arch are placeholders.
      expect(
        /^https:\/\/github\.com\/VSCodium\/vscodium\/releases\/download\/1\.135\.06055\/vscodium-reh-[a-z0-9]+-[a-z0-9]+-1\.135\.06055\.tar\.gz$/.test(
          url,
        ),
        `unexpected URL: ${url}`,
      ).toBe(true);
      expect(url.includes("${"), "every placeholder must be substituted").toBe(false);
    });

    it("a product with no template falls back to Microsoft's update server", async () => {
      await running("ms2", MICROSOFT);
      const url = await serverDownloadUrl("abc123");
      expect(url.startsWith("https://update.code.visualstudio.com/commit:abc123/server-"), url).toBe(true);
      expect(url.endsWith("/stable"), url).toBe(true);
      expect(url.includes("${"), "every placeholder must be substituted").toBe(false);
    });

    it("the setting overrides what the product declares", async () => {
      // Otherwise there would be no way to point VSCodium at a mirror.
      await running("codium3", VSCODIUM);
      const url = await serverDownloadUrl("c0ffee", "https://mirror.invalid/${commit}/${os}-${arch}");
      expect(/^https:\/\/mirror\.invalid\/c0ffee\/[a-z0-9]+-[a-z0-9]+$/.test(url), url).toBe(true);
    });

    it("an existing ${platform} override keeps working", async () => {
      // This spelling is what the setting has always used; it must not break on upgrade.
      await running("ms3", MICROSOFT);
      const url = await serverDownloadUrl("c0ffee", "https://example.invalid/${commit}/${platform}");
      expect(/^https:\/\/example\.invalid\/c0ffee\/[a-z0-9]+-[a-z0-9]+$/.test(url), url).toBe(true);
    });

    it("a blank setting is not treated as an override", async () => {
      // The setting's default is empty, and empty has to mean "detect it".
      await running("codium4", VSCODIUM);
      const url = await serverDownloadUrl("x", "   ");
      expect(url, "whitespace is not a URL").toContain("github.com/VSCodium");
    });

    it("callers racing the first read share it instead of repeating it", async () => {
      // Concurrent callers share one read: the memo holds the promise.
      stub.env.appRoot = await appRoot("racing", VSCODIUM);
      forgetProduct();
      const [a, b, c] = await Promise.all([clientProduct(), clientProduct(), clientProduct()]);
      expect(a === b && b === c, "concurrent callers got separate reads").toBe(true);
      expect(a.serverApplicationName).toEqual("codium-server");
    });

    it("the memo survives later calls", async () => {
      const first = await clientProduct();
      stub.env.appRoot = await appRoot("changed", MICROSOFT);
      expect(await clientProduct(), "the running editor cannot change under us").toEqual(first);
    });

    it("forgetting the memo reads again", async () => {
      forgetProduct();
      expect((await clientProduct()).serverApplicationName).toEqual("code-server");
    });

    it("an editor with no appRoot is assumed to be a Microsoft build", async () => {
      stub.env.appRoot = undefined;
      forgetProduct();
      expect((await clientProduct()).serverApplicationName).toEqual("code-server");
    });
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
});
