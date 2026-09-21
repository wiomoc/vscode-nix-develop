import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { resolveNixExtensions, syncNixExtensions } from "../src/remote/extensions";
import { manifestPath } from "../src/remote/extensions-manifest";

/** A stand-in for the `$out` of an extension package, as either source builds it. */
async function pkg(root: string, name: string, ids: string[], version = "1.0.0"): Promise<string> {
  const base = path.join(root, name, "share", "vscode", "extensions");
  for (const id of ids) {
    await fs.mkdir(path.join(base, id), { recursive: true });
    const [publisher, ...rest] = id.split(".");
    await fs.writeFile(
      path.join(base, id, "package.json"),
      JSON.stringify({ publisher, name: rest.join("."), version }),
    );
  }
  return path.join(root, name);
}

const root = await fs.mkdtemp(path.join(os.tmpdir(), "nd-nixext-"));
const a = await pkg(root, "pkg-a", ["jnoortheen.nix-ide"], "0.5.13");
const b = await pkg(root, "pkg-b", ["tamasfe.even-better-toml"], "0.21.2");

describe("nix-supplied extensions", () => {
  it("reads the extension a package supplies", async () => {
    // `vscodeExtensions = [ pkgs.vscode-extensions.jnoortheen.nix-ide ]` arrives as $out.
    const found = await resolveNixExtensions([a]);
    expect(found).toEqual([
      {
        id: "jnoortheen.nix-ide",
        path: path.join(a, "share", "vscode", "extensions", "jnoortheen.nix-ide"),
      },
    ]);
  });

  it("reads several packages in declaration order", async () => {
    const found = await resolveNixExtensions([a, b]);
    expect(found.map((e) => e.id)).toEqual(["jnoortheen.nix-ide", "tamasfe.even-better-toml"]);
  });

  it("a package supplying several extensions yields all of them", async () => {
    const multi = await pkg(root, "pkg-multi", ["one.first", "two.second"]);
    const found = await resolveNixExtensions([multi]);
    expect(found.map((e) => e.id)).toEqual(["one.first", "two.second"]);
  });

  it("the same package named twice is linked once", async () => {
    expect((await resolveNixExtensions([a, a])).length).toEqual(1);
  });

  it("skips directories without a package.json", async () => {
    const stray = path.join(root, "stray", "share", "vscode", "extensions", "not-an-extension");
    await fs.mkdir(stray, { recursive: true });
    expect(await resolveNixExtensions([path.join(root, "stray")])).toEqual([]);
  });

  it("skips a package that is not an extension at all", async () => {
    // A store path in the list that holds no extension costs that entry, not the window.
    await fs.mkdir(path.join(root, "just-a-package", "bin"), { recursive: true });
    expect(await resolveNixExtensions([path.join(root, "just-a-package"), "/definitely/not/here", b])).toEqual([{ id: "tamasfe.even-better-toml", path: path.join(b, "share", "vscode", "extensions", "tamasfe.even-better-toml") }]);
  });
});

describe("linking nix extensions", () => {
  it("links them into the extension directory", async () => {
    const dir = path.join(root, "ext1");
    const res = await syncNixExtensions(dir, await resolveNixExtensions([a, b]));
    expect(res.linked).toEqual(["jnoortheen.nix-ide", "tamasfe.even-better-toml"]);
    expect((await fs.readdir(dir)).sort()).toEqual(["jnoortheen.nix-ide", "tamasfe.even-better-toml"]);
  });

  it("is idempotent", async () => {
    const dir = path.join(root, "ext2");
    const wanted = await resolveNixExtensions([a]);
    await syncNixExtensions(dir, wanted);
    const again = await syncNixExtensions(dir, wanted);
    expect(again.linked, "an unchanged extension must not be relinked").toEqual([]);
    expect(again.removed).toEqual([]);
  });

  it("drops links the devShell no longer declares", async () => {
    const dir = path.join(root, "ext3");
    const both = await resolveNixExtensions([a, b]);
    const justA = await resolveNixExtensions([a]);
    await syncNixExtensions(dir, both);
    const res = await syncNixExtensions(dir, justA);
    expect(res.removed).toEqual(["tamasfe.even-better-toml"]);
    expect(await fs.readdir(dir)).toEqual(["jnoortheen.nix-ide"]);
  });

  it("a version bump retargets the link rather than dropping it", async () => {
    // Retargeting is safe: the extension never ends up without files.
    const dir = path.join(root, "ext3c");
    const v1 = await pkg(root, "pkg-v1", ["acme.tool"]);
    const v2 = await pkg(root, "pkg-v2", ["acme.tool"]);
    await syncNixExtensions(dir, await resolveNixExtensions([v1]));
    const res = await syncNixExtensions(dir, await resolveNixExtensions([v2]));
    expect(res.linked).toEqual(["acme.tool"]);
    expect(res.removed, "a retarget is not a removal").toEqual([]);
    const link = await fs.readlink(path.join(dir, "acme.tool"));
    expect(link.startsWith(v2), `expected the v2 path, got ${link}`).toBe(true);
  });

  it("never removes a Marketplace-installed extension", async () => {
    const dir = path.join(root, "ext4");
    await fs.mkdir(path.join(dir, "esbenp.prettier-vscode"), { recursive: true });
    const res = await syncNixExtensions(dir, []);
    expect(res.removed, "a real directory is not ours to delete").toEqual([]);
    expect((await fs.readdir(dir)), "it must still be there").toContain("esbenp.prettier-vscode");
  });
});

/** An extensions directory with a server record already in it. */
async function recorded(name: string, entries: unknown[]): Promise<string> {
  const dir = path.join(root, name);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(manifestPath(dir), JSON.stringify(entries));
  return dir;
}

/** `extensions.json` as the server would read it back. */
async function record(dir: string): Promise<any[]> {
  return JSON.parse(await fs.readFile(manifestPath(dir), "utf8"));
}

const galleryEntry = {
  identifier: { id: "esbenp.prettier-vscode", uuid: "96fa4707" },
  version: "12.4.0",
  location: { $mid: 1, path: "/somewhere/esbenp.prettier-vscode-12.4.0", scheme: "file" },
  relativeLocation: "esbenp.prettier-vscode-12.4.0",
  metadata: { source: "gallery" },
};

describe("the server's record of the directory", () => {
  it("records a linked extension, so the server does not throw it out", async () => {
    const dir = await recorded("rec1", [galleryEntry]);
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    const entry = (await record(dir)).find((e) => e.identifier.id === "jnoortheen.nix-ide");
    expect(entry?.version, "the version the package.json declares").toEqual("0.5.13");
    expect(entry?.relativeLocation, "this is what the server resolves").toEqual("jnoortheen.nix-ide");
    expect(entry?.location.path).toEqual(path.join(dir, "jnoortheen.nix-ide"));
  });

  it("leaves entries that are not ours alone", async () => {
    const dir = await recorded("rec2", [galleryEntry]);
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    const entry = (await record(dir)).find((e) => e.identifier.id === "esbenp.prettier-vscode");
    expect(entry, "another installer's entry is not ours to rewrite").toEqual(galleryEntry);
  });

  it("keeps the uuid and metadata an earlier install left behind", async () => {
    // They are how the editor matches the extension against the Marketplace, and a
    // re-record has nothing better to put there.
    const dir = await recorded("rec3", [
      {
        identifier: { id: "jnoortheen.nix-ide", uuid: "0ffebccd" },
        version: "0.4.0",
        location: { $mid: 1, path: "/old/jnoortheen.nix-ide", scheme: "file" },
        relativeLocation: "jnoortheen.nix-ide",
        metadata: { publisherDisplayName: "Noortheen" },
      },
    ]);
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    const [entry] = await record(dir);
    expect(entry.identifier.uuid).toEqual("0ffebccd");
    expect(entry.metadata).toEqual({ publisherDisplayName: "Noortheen" });
    expect(entry.version, "but the version follows the link").toEqual("0.5.13");
  });

  it("drops the entry for an extension it unlinks", async () => {
    const dir = await recorded("rec4", []);
    await syncNixExtensions(dir, await resolveNixExtensions([a, b]));
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    expect(
      (await record(dir)).map((e) => e.identifier.id),
      "a record naming a directory that is gone is what we are fixing",
    ).toEqual(["jnoortheen.nix-ide"]);
  });

  it("takes a linked extension off the removal list", async () => {
    // This is the state a devShell is left in by a start that rejected the link: marked
    // obsolete, and so invisible even once the record names it again.
    const dir = await recorded("rec5", []);
    await fs.writeFile(
      path.join(dir, ".obsolete"),
      JSON.stringify({ "jnoortheen.nix-ide-0.5.13": true, "other.ext-1.0.0": true }),
    );
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    expect(JSON.parse(await fs.readFile(path.join(dir, ".obsolete"), "utf8"))).toEqual({
      "other.ext-1.0.0": true,
    });
  });

  it("writes no record where the server has not written one", async () => {
    // Its absence is what makes the server migrate the whole directory on its next start,
    // which finds our links. A partial file would take that migration away.
    const dir = path.join(root, "rec6");
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    expect(await fs.readdir(dir), "the link, and nothing else").toEqual(["jnoortheen.nix-ide"]);
  });

  it("leaves a record it cannot read alone", async () => {
    const dir = await recorded("rec7", []);
    await fs.writeFile(manifestPath(dir), "{ not a list");
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    expect(await fs.readFile(manifestPath(dir), "utf8")).toEqual("{ not a list");
  });

  it("leaves a record with an entry it cannot read alone", async () => {
    // Rewriting it could drop an extension that works today; the server rejects the whole
    // file over one bad entry, so a guess is expensive.
    const dir = await recorded("rec8", [{ identifier: { id: "a.b" } }]);
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    expect(await record(dir)).toEqual([{ identifier: { id: "a.b" } }]);
  });

  it("does not rewrite a record that already says the right thing", async () => {
    const dir = await recorded("rec9", []);
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    const before = await fs.stat(manifestPath(dir));
    const text = await fs.readFile(manifestPath(dir), "utf8");
    await syncNixExtensions(dir, await resolveNixExtensions([a]));
    expect(await fs.readFile(manifestPath(dir), "utf8")).toEqual(text);
    expect((await fs.stat(manifestPath(dir))).mtimeMs, "an unchanged run must not touch it").toEqual(before.mtimeMs);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
});
