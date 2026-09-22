import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { log } from "../utils/log";

/**
 * The parts of the running editor's `product.json` that decide which server to fetch, so
 * VSCodium and other rebuilds work without special-casing. Must be read on the client.
 */
export interface ClientProduct {
  /** `code-server`, `codium-server`: the launcher's name inside the distribution's `bin/`. */
  serverApplicationName: string;
  /** Where this product's other remote features unpack servers, e.g. `.vscode-server`. */
  serverDataFolderName: string;
  /** Where its CLI keeps state, e.g. `.vscode` or `.vscode-oss`. */
  dataFolderName: string;
  /** Where to download a matching server. VSCodium sets it; Microsoft's build does not. */
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

/** The default for Microsoft's build, which has no `serverDownloadUrlTemplate`. */
const MICROSOFT_SERVER_URL =
  "https://update.code.visualstudio.com/commit:${commit}/server-${os}-${arch}/${quality}";

let cached: Promise<ClientProduct> | undefined;

/**
 * The running editor's product description. The promise is memoised, so concurrent
 * callers share one read; `readProduct` never rejects. Tests call `readProduct` directly.
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

/** The OS and architecture names server distributions use (same for both products). */
export function serverOsArch(): { os: string; arch: string } {
  const arch =
    process.arch === "arm64" ? "arm64" : process.arch === "arm" ? "armhf" : "x64";
  if (process.platform === "darwin") {
    return { os: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64" };
  }
  if (process.platform === "win32") return { os: "win32", arch };
  return { os: "linux", arch };
}

/** Fill in a server download template's `${...}` placeholders. */
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
 * Where to fetch a server matching `commit`: `nixDevShell.remote.serverDownloadUrl` if
 * set, else the product's template, else Microsoft's update server.
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
