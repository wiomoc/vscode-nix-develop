import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "../utils/log";

/**
 * The parts of the running editor's `product.json` that decide which server to fetch.
 *
 * Everything this extension needs in order to work against VSCodium instead of Microsoft's
 * build is written down by the editor itself, so nothing here identifies a product by name.
 * VSCodium is not special-cased; it is simply a product whose `product.json` says its
 * server is called `codium-server` and lives on GitHub. The same reading makes Code - OSS,
 * Insiders and other rebuilds work for free.
 *
 * This must be read on the *client* side. A devShell window's extension host has an
 * `appRoot` inside the server, whose `product.json` describes the server rather than the
 * editor that has to match it -- but resolving an authority is the client's job, so the
 * resolver reads the right one.
 */
export interface ClientProduct {
  /** `code-server`, `codium-server`: the launcher's name inside the distribution's `bin/`. */
  serverApplicationName: string;
  /** Where this product's other remote features unpack servers, e.g. `.vscode-server`. */
  serverDataFolderName: string;
  /** Where its CLI keeps state, e.g. `.vscode` or `.vscode-oss`. */
  dataFolderName: string;
  /**
   * The product's own answer to "where do I download a matching server?".
   *
   * VSCodium ships one, fully resolved down to its release tag. Microsoft's desktop
   * `product.json` does not -- there the URL lives in the CLI -- so its absence is normal
   * and means the built-in default applies.
   */
  serverDownloadUrlTemplate?: string;
  quality: string;
  version: string;
  commit?: string;
  nameLong: string;
}

/** What to assume when there is no `product.json` to read: Microsoft's build. */
const MICROSOFT: ClientProduct = {
  serverApplicationName: "code-server",
  serverDataFolderName: ".vscode-server",
  dataFolderName: ".vscode",
  quality: "stable",
  version: "",
  nameLong: "Visual Studio Code",
};

/**
 * Microsoft's desktop build does not carry a `serverDownloadUrlTemplate`, so this is the
 * one piece of product knowledge that cannot be read off disk. Spelled with the same
 * `${os}`/`${arch}` placeholders a `product.json` template uses.
 */
const MICROSOFT_SERVER_URL =
  "https://update.code.visualstudio.com/commit:${commit}/server-${os}-${arch}/${quality}";

let cached: Promise<ClientProduct> | undefined;

/**
 * The running editor's product description.
 *
 * Memoised, because it cannot change while the window is open and it sits on the path to
 * opening a devShell window. What is kept is the *promise*, so that callers arriving while
 * the first read is still in flight join it instead of starting their own -- caching only
 * the result would let a burst of callers each read the file.
 *
 * Safe to cache a promise here because `readProduct` does not reject: an unreadable
 * `product.json` resolves to the Microsoft defaults rather than failing, so there is no
 * rejection to get stuck on.
 *
 * There is deliberately no way to ask for a different `appRoot`: with one memo there is one
 * running editor, and a parameter would only be honoured for whoever called first. Tests
 * that need a specific `product.json` call `readProduct` directly.
 */
export function clientProduct(): Promise<ClientProduct> {
  cached ??= (async () => {
    const root = vscode.env.appRoot;
    return root ? readProduct(root) : { ...MICROSOFT };
  })();
  return cached;
}

/** Exported for tests, which need a different `product.json` per case. */
export async function readProduct(appRoot: string): Promise<ClientProduct> {
  const file = path.join(appRoot, "product.json");
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await fs.readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    // Not every build ships one where it is expected, and being wrong about the product is
    // better than refusing to open a devShell window at all.
    log.info(`no readable product.json at ${file}; assuming a Microsoft build`);
    return { ...MICROSOFT };
  }

  const str = (key: string, fallback: string): string =>
    typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : fallback;

  const product: ClientProduct = {
    serverApplicationName: str("serverApplicationName", MICROSOFT.serverApplicationName),
    serverDataFolderName: str("serverDataFolderName", MICROSOFT.serverDataFolderName),
    dataFolderName: str("dataFolderName", MICROSOFT.dataFolderName),
    serverDownloadUrlTemplate:
      typeof raw.serverDownloadUrlTemplate === "string" && raw.serverDownloadUrlTemplate
        ? raw.serverDownloadUrlTemplate
        : undefined,
    quality: str("quality", "stable"),
    version: str("version", vscode.version ?? ""),
    commit: typeof raw.commit === "string" ? raw.commit : undefined,
    nameLong: str("nameLong", MICROSOFT.nameLong),
  };

  log.info(
    `client product: ${product.nameLong} ${product.version} (${product.quality}), ` +
      `server '${product.serverApplicationName}'` +
      (product.serverDownloadUrlTemplate ? ", with its own download URL" : ""),
  );
  return product;
}

/** Forget the memoised product, so the next call reads again. Tests only. */
export function forgetProduct(): void {
  cached = undefined;
}

/**
 * The OS and architecture names a server distribution is labelled with.
 *
 * Both products spell these the same way, which is why one mapping serves both: VSCodium's
 * release assets are `vscodium-reh-linux-x64-…` next to Microsoft's `server-linux-x64`.
 */
export function serverOsArch(): { os: string; arch: string } {
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "arm" ? "armhf" : "x64";
  if (process.platform === "darwin") {
    return { os: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64" };
  }
  if (process.platform === "win32") return { os: "win32", arch };
  return { os: "linux", arch };
}

/**
 * Fill in a server download template.
 *
 * `${os}`/`${arch}` are what a `product.json` template uses; `${platform}` is the spelling
 * this extension's own setting has always used, kept so an existing override keeps working.
 */
function expandServerUrl(
  template: string,
  values: { commit: string; quality: string; version: string },
): string {
  const { os, arch } = serverOsArch();
  return template
    .replace(/\$\{commit\}/g, values.commit)
    .replace(/\$\{quality\}/g, values.quality)
    .replace(/\$\{version\}/g, values.version)
    .replace(/\$\{os\}/g, os)
    .replace(/\$\{arch\}/g, arch)
    .replace(/\$\{platform\}/g, `${os}-${arch}`);
}

/**
 * Where to fetch a server matching `commit`.
 *
 * `configured` is `nixDevelop.remote.serverDownloadUrl`, and it wins when it is set, since
 * overriding exactly this is what it exists for. Otherwise the product is asked: VSCodium's
 * `product.json` carries a `serverDownloadUrlTemplate` pointing at its own GitHub release,
 * with the release tag already resolved, which is what makes it work with no configuration
 * at all. Microsoft's desktop build carries none -- there the URL lives in the CLI, not the
 * `product.json` -- so the built-in default stands in, and that default is Microsoft's
 * update server.
 */
export async function serverDownloadUrl(
  commit: string,
  configured = "",
): Promise<string> {
  const product = await clientProduct();
  const override = configured.trim();
  const template = override || product.serverDownloadUrlTemplate || MICROSOFT_SERVER_URL;
  if (!override && product.serverDownloadUrlTemplate) {
    log.info(`using the server download URL ${product.nameLong} declares for itself`);
  }
  return expandServerUrl(template, {
    commit,
    quality: product.quality,
    version: product.version,
  });
}
