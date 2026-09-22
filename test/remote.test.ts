import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  authorityFor,
  authorityId,
  decodeAuthority,
  storageKeyFor,
} from "../src/remote/authority";
import {
  collectExtensions,
  extensionsDirFor,
  installedIn,
} from "../src/remote/extensions";
import { serverPlatform } from "../src/remote/server";
import { glibcLinkerName } from "../src/remote/server-ld-patch";
import { registerResourceLabelFormatter } from "../src/ui";
import { killServer, reopenInDevShell } from "../src/remote/index";
import * as stub from "./activation-stub";

const target = { folder: "/w/proj", flakeDir: "/w/proj", devShell: "default" };

describe("remote authorities", () => {
  it("an authority round-trips to the target it describes", () => {
    const decoded = decodeAuthority(authorityFor(target));
    expect(decoded, "the authority is the mapping; nothing else stores it").toEqual(target);
  });

  it("uses only characters that are unreserved in a URI authority", () => {
    const payload = authorityId(authorityFor({ ...target, folder: "/w/pro ject+odd" }));
    expect(/^[a-z2-7]+$/.test(payload), `lower-case base32 expected, got ${payload}`).toBe(true);
  });

  it("survives the authority being lower-cased", () => {
    // A URI authority is case-insensitive by RFC 3986, and VS Code acts on it: an authority
    // restored from persisted state after a restart comes back lower-cased. An encoding that
    // depends on case (base64) silently stops resolving the moment the editor is restarted.
    for (const t of [
      target,
      { folder: "/w/MixedCase/Proj", flakeDir: "/w/MixedCase/Proj", devShell: "CI" },
      { folder: "/w/p", flakeDir: "/w/p/nix", devShell: "Dev-Shell" },
    ]) {
      const authority = authorityFor(t);
      expect(authority, "the authority must already be lower case").toEqual(authority.toLowerCase());
      expect(decodeAuthority(authority.toLowerCase()), "and must decode after folding").toEqual(t);
      expect(decodeAuthority(authority.toUpperCase()), "in either direction").toEqual(t);
    }
  });

  it("survives paths and devShell names that need escaping", () => {
    for (const t of [
      { folder: "/w/a b/c+d", flakeDir: "/w/a b/c+d", devShell: "shell/with#chars" },
      { folder: "/w/ünïcode", flakeDir: "/w/ünïcode", devShell: "dév" },
      { folder: "/w/p", flakeDir: "/w/p/nix", devShell: "ci" },
    ]) {
      expect(decodeAuthority(authorityFor(t)), `round trip failed for ${JSON.stringify(t)}`).toEqual(t);
    }
  });

  it("carries flakeDir only when it differs from the folder", () => {
    const same = authorityFor(target).length;
    const differs = authorityFor({ ...target, flakeDir: "/w/proj/nix" }).length;
    expect(differs > same, "a separate flakeDir has to be encoded").toBe(true);
    expect(decodeAuthority(authorityFor(target))!.flakeDir, "and defaults to the folder").toEqual("/w/proj");
  });

  it("different devShells in one folder get different authorities", () => {
    const a = authorityFor(target);
    const b = authorityFor({ ...target, devShell: "ci" });
    expect(a !== b, "each devShell needs its own authority, or they share a server").toBe(true);
  });

  it("rejects anything that is not one of ours", () => {
    // The previous scheme's opaque digest decodes as base64 but means nothing.
    expect(decodeAuthority("nix-develop+44f5ce469662698e"), "an old digest").toEqual(undefined);
    expect(decodeAuthority("nix-develop+"), "an empty payload").toEqual(undefined);
    expect(decodeAuthority("nix-develop+not/base64url"), "illegal characters").toEqual(undefined);
    expect(
      decodeAuthority("nix-develop+" + Buffer.from("relative/path\u0000dev").toString("base64url")),
      "a folder that is not absolute",
    ).toEqual(undefined);
    expect(
      decodeAuthority("nix-develop+" + Buffer.from("/w/proj").toString("base64url")),
      "a payload with no devShell",
    ).toEqual(undefined);
  });

  it("storage keys stay short whatever the path length", () => {
    const deep = "/home/u/" + "nested/".repeat(40) + "project";
    const authority = authorityFor({ folder: deep, flakeDir: deep, devShell: "default" });
    expect(authority.length > 255, `expected a long authority, got ${authority.length}`).toBe(true);
    const key = storageKeyFor(authority);
    expect(key.length, "a directory name must not grow with the path").toEqual(16);
    expect(/^[0-9a-f]+$/.test(key), "and must be filesystem-safe").toBe(true);
    expect(storageKeyFor(authority), "and stable").toEqual(key);
  });
});

type LabelFormatter = {
  scheme: string;
  authority?: string;
  formatting: { workspaceSuffix?: string; workspaceTooltip?: string };
};

/**
 * The formatters the extension registers, in registration order, for a window sitting
 * in `authority`. The devShell is read back out of the authority rather than passed in,
 * so these go through `authorityFor`.
 */
const formattersIn = (authority: string | undefined): LabelFormatter[] => {
  const captured: LabelFormatter[] = [];
  const previous = stub.env.remoteAuthority;
  stub.env.remoteAuthority = authority;
  try {
    registerResourceLabelFormatter({
      registerResourceLabelFormatter: (f) => {
        captured.push(f);
        return { dispose() {} };
      },
    });
  } finally {
    stub.env.remoteAuthority = previous;
  }
  return captured;
};

describe("workspace label", () => {
  it("names the devShell in the workspace suffix", () => {
    const [, exact] = formattersIn(
      authorityFor({ folder: "/w/p", flakeDir: "/w/p", devShell: "ci" }),
    );
    expect(exact.formatting.workspaceSuffix).toEqual("devShell: ci");
    expect(exact.formatting.workspaceTooltip!, "the tooltip should name it too").toContain("ci");
  });

  it("leaves `default` unnamed", () => {
    // A bare `nix develop` picks it, so spelling it out distinguishes nothing.
    const [, exact] = formattersIn(
      authorityFor({ folder: "/w/p", flakeDir: "/w/p", devShell: "default" }),
    );
    expect(exact.formatting.workspaceSuffix).toEqual("devShell");
  });

  it("binds to the exact authority so it outranks the wildcard", () => {
    // findFormatting prefers the longest matching authority pattern.
    const authority = authorityFor({ folder: "/w/p", flakeDir: "/w/p", devShell: "ci" });
    const [wildcard, exact] = formattersIn(authority);
    expect(exact.authority).toEqual(authority);
    expect(
      exact.authority!.length > wildcard.authority!.length,
      "an exact authority must be longer than the wildcard to win",
    ).toBe(true);
  });

  it("registers only the wildcard outside a devShell", () => {
    // A local window has no devShell to name, and so nothing to outrank the wildcard.
    const formatters = formattersIn(undefined);
    expect(formatters.length, "a local window should get one formatter").toEqual(1);
    expect(formatters[0].authority).toEqual("nix-develop+*");
  });
});

describe("per-devShell extensions", () => {
  it("reads extension ids the flake declares via a list attribute", () => {
    // `mkShell { vscodeExtensions = [ "a.b" "c.d" ]; }` arrives space-separated.
    const { ids } = collectExtensions({ vscodeExtensions: "rust-lang.rust-analyzer tamasfe.even-better-toml" });
    expect(ids).toEqual(["rust-lang.rust-analyzer", "tamasfe.even-better-toml"]);
  });

  it("accepts comma separation and a pinned version", () => {
    const { ids } = collectExtensions({ vscodeExtensions: "golang.go, ms-python.python@2024.1.0" });
    expect(ids).toEqual(["golang.go", "ms-python.python@2024.1.0"]);
  });

  it("rejects values that are not publisher.name ids", () => {
    const { ids } = collectExtensions({ vscodeExtensions: "not-an-id ok.good ../../evil" });
    expect(ids, "malformed entries must not reach --install-extension").toEqual(["ok.good"]);
  });

  it("a devShell that declares nothing wants nothing installed", () => {
    expect(collectExtensions({})).toEqual({ ids: [], paths: [] });
  });

  it("drops duplicates across the flake's extension variables", () => {
    const { ids } = collectExtensions({
      vscodeExtensions: "a.b c.d",
      VSCODE_EXTENSIONS: "c.d x.y",
    });
    expect(ids).toEqual(["a.b", "c.d", "x.y"]);
  });

  it("separates Nix packages from Marketplace ids", () => {
    // A derivation in the list stringifies to its store path, so both forms arrive in
    // the same variable and are told apart by shape.
    const declared = collectExtensions({
      vscodeExtensions:
        "/nix/store/aaa-vscode-extension-jnoortheen-nix-ide-0.5.13 esbenp.prettier-vscode",
    });
    expect(declared.paths).toEqual(["/nix/store/aaa-vscode-extension-jnoortheen-nix-ide-0.5.13"]);
    expect(declared.ids, "a store path is not an id to install").toEqual(["esbenp.prettier-vscode"]);
  });

  it("drops duplicate package paths", () => {
    const { paths } = collectExtensions({
      vscodeExtensions: "/nix/store/aaa-ext /nix/store/aaa-ext /nix/store/bbb-ext",
    });
    expect(paths).toEqual(["/nix/store/aaa-ext", "/nix/store/bbb-ext"]);
  });

  it("each devShell gets its own extensions directory", () => {
    // This is what makes a devShell's extension set actually be that devShell's.
    expect(
      extensionsDirFor("/root", "aaa") !== extensionsDirFor("/root", "bbb"),
      "two devShells must not share a directory",
    ).toBe(true);
    expect(extensionsDirFor("/root", "aaa"), "and it must be stable").toEqual(extensionsDirFor("/root", "aaa"));
  });

  it("lists installed extensions, stripping version suffixes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-ext-"));
    await fs.mkdir(path.join(dir, "rust-lang.rust-analyzer-0.3.2000"), { recursive: true });
    await fs.mkdir(path.join(dir, "golang.go-0.41.4"), { recursive: true });
    await fs.writeFile(path.join(dir, "extensions.json"), "[]");
    expect(await installedIn(dir)).toEqual(["golang.go", "rust-lang.rust-analyzer"]);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a missing extensions directory lists as empty", async () => {
    expect(await installedIn("/definitely/not/here")).toEqual([]);
  });
});

describe("server platform", () => {
  it("maps this machine to a server distribution", () => {
    const p = serverPlatform();
    expect(/^(linux|darwin|win32)-(x64|arm64|armhf)$/.test(p), `unexpected platform: ${p}`).toBe(true);
  });
});

// Taken from nixpkgs' own `stdenv.cc.bintools.dynamicLinker` for each system, so this
// pins the aarch64 answer on an x86_64 machine, where nothing else would exercise it.

describe("glibc linker", () => {
  it("names the ELF interpreter per architecture", () => {
    expect(glibcLinkerName("x64")).toEqual("ld-linux-x86-64.so.2");
    expect(glibcLinkerName("arm64")).toEqual("ld-linux-aarch64.so.1");
  });

  it("refuses an architecture it has no linker for", () => {
    // nixpkgs spells armv7l's as the unresolved glob `ld-linux*.so.3`, so there is no
    // single name to hardcode; a loud failure beats patching against a path that is not
    // there, which only shows up when the server fails to exec its own node.
    let message = "";
    try {
      glibcLinkerName("arm");
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message, `expected the architecture to be named, got: ${message}`).toContain("arm");
  });

  it("this machine is one of them", () => {
    expect(glibcLinkerName().startsWith("ld-linux-"), "the running arch must resolve").toBe(true);
  });
});

/** Run the command in a window sitting at `authority`, against an empty storage dir. */
const kill = async (authority: string | undefined, folderUri: unknown) => {
  const storage = await fs.mkdtemp(path.join(os.tmpdir(), "nd-kill-"));
  const previous = stub.env.remoteAuthority;
  stub.env.remoteAuthority = authority;
  stub.recorded.executed.length = 0;
  stub.recorded.infoMessages.length = 0;
  try {
    await killServer(
      { globalStorageUri: { fsPath: storage } } as never,
      folderUri ? ({ uri: folderUri } as never) : undefined,
    );
  } finally {
    stub.env.remoteAuthority = previous;
    await fs.rm(storage, { recursive: true, force: true });
  }
};

describe("stopping a devShell server", () => {
  it("a window with no devShell behind it has nothing to stop", async () => {
    await kill(undefined, undefined);
    expect(stub.recorded.infoMessages).toEqual(["No devShell server is associated with this window."]);
    expect(stub.recorded.executed.includes("vscode.openFolder"), "and stays where it is").toBe(false);
  });

  it("stopping this window's own server leaves the folder in a local window", async () => {
    // That server was the window's extension host and the file system serving the
    // checkout, so the command has to put the folder somewhere that can still show it.
    const authority = authorityFor({ folder: "/w/proj", flakeDir: "/w/proj", devShell: "default" });
    await kill(authority, stub.Uri.from({ scheme: "vscode-remote", authority, path: "/w/proj" }));
    expect(stub.recorded.executed, "the window was left with nothing").toContain("vscode.openFolder");
  });
});

describe("reopening without the proposed API", () => {
  // `resolvers` is granted at launch and never mid-session, so the only useful thing to
  // say is how to grant it for the *next* launch -- and the durable way to do that is
  // argv.json, not a --enable-proposed-api flag that one dock click would drop.
  const folder = { uri: stub.Uri.file("/w/proj"), name: "proj", index: 0 };

  it("points at argv.json and names the id to put there", async () => {
    stub.recorded.warningMessages.length = 0;
    stub.recorded.executed.length = 0;

    await reopenInDevShell(folder as never, "default", "/w/proj");

    const warning = stub.recorded.warningMessages[0];
    expect(warning?.message).toContain('"enable-proposed-api": ["wiomoc.nix-develop"]');
    expect(warning?.message, "argv.json is only read at launch").toContain("restart");
    expect(
      stub.recorded.executed.includes("vscode.openFolder"),
      "a window opened here would fail to resolve, so it is not opened",
    ).toBe(false);
  });

  it("the offer opens argv.json rather than leaving the path to be found", async () => {
    stub.recorded.warningMessages.length = 0;
    stub.recorded.executed.length = 0;
    stub.answers.warningMessage = (_m, items) => items[0];
    try {
      await reopenInDevShell(folder as never, "default", "/w/proj");
    } finally {
      stub.answers.warningMessage = undefined;
    }

    expect(stub.recorded.warningMessages[0]?.items[0]).toEqual("Open argv.json");
    expect(stub.recorded.executed).toContain("workbench.action.configureRuntimeArguments");
  });
});
