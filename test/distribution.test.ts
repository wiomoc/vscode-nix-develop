import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { findDistributionRoot } from "../src/remote/server";

/** Where an unpacked distribution begins: Microsoft's has a wrapper directory, VSCodium's not. */

const root = await fs.mkdtemp(path.join(os.tmpdir(), "nd-layout-"));
const build = async (name: string, inner?: string): Promise<string> => {
  const dir = path.join(root, name);
  const at = inner ? path.join(dir, inner) : dir;
  await fs.mkdir(path.join(at, "bin"), { recursive: true });
  await fs.writeFile(path.join(at, "product.json"), "{}");
  return dir;
};

describe("distribution layout", () => {
  it("a flat distribution is its own root, as VSCodium ships it", async () => {
    const dir = await build("flat");
    expect(await findDistributionRoot(dir)).toEqual(dir);
  });

  it("a wrapped distribution is found inside, as Microsoft ships it", async () => {
    const dir = await build("wrapped", "vscode-server-linux-x64");
    expect(await findDistributionRoot(dir)).toEqual(path.join(dir, "vscode-server-linux-x64"));
  });

  it("an archive with nothing recognisable in it is rejected", async () => {
    // Better a clear failure than a directory that looks extracted and is not.
    const dir = path.join(root, "junk");
    await fs.mkdir(path.join(dir, "a"), { recursive: true });
    await fs.mkdir(path.join(dir, "b"), { recursive: true });
    expect(await findDistributionRoot(dir)).toEqual(undefined);
  });

  afterAll(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });
});
