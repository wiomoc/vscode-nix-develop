import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  applyMachineSettings,
  collectSettings,
  machineSettingsPath,
  parseFlakeSettings,
  parseJsonc,
} from "../src/provision/settings";

/**
 * Settings a devShell declares for the editor.
 *
 * The parsing is where the risk is: a derivation attribute is always a string, so the same
 * `vscodeSettings` may arrive as JSON, as a list flattened onto one line, or as a here-doc
 * of `key=value` lines, and a store path must survive all three untouched.
 */
describe("per-devShell settings", () => {
  it("reads a JSON object, as builtins.toJSON renders it", () => {
    const s = parseFlakeSettings('{"nix.serverPath":"/nix/store/abc-nil/bin/nil","nix.enableLanguageServer":true}');
    expect(s).toEqual({ "nix.serverPath": "/nix/store/abc-nil/bin/nil", "nix.enableLanguageServer": true });
  });

  it("keeps nested values, so an object setting survives", () => {
    const s = parseFlakeSettings('{"[nix]":{"editor.tabSize":2},"files.exclude":{"**/result":true}}');
    expect(s).toEqual({ "[nix]": { "editor.tabSize": 2 }, "files.exclude": { "**/result": true } });
  });

  it("reads key=value lines, as a multi-line string yields them", () => {
    const s = parseFlakeSettings("nix.serverPath=/nix/store/abc-nil/bin/nil\nnix.enableLanguageServer=true\n");
    expect(s).toEqual({ "nix.serverPath": "/nix/store/abc-nil/bin/nil", "nix.enableLanguageServer": true });
  });

  it("reads a Nix list, which arrives space-separated on one line", () => {
    const s = parseFlakeSettings("editor.tabSize=2 editor.formatOnSave=true");
    expect(s).toEqual({ "editor.tabSize": 2, "editor.formatOnSave": true });
  });

  it("a value with spaces stays one setting", () => {
    // Only a line whose every word is a pair can be several pairs; this one is not.
    const s = parseFlakeSettings("terminal.integrated.defaultProfile.linux=my shell");
    expect(s).toEqual({ "terminal.integrated.defaultProfile.linux": "my shell" });
  });

  it("a path that is not JSON stays the string it looks like", () => {
    const s = parseFlakeSettings("python.defaultInterpreterPath=/nix/store/xyz/bin/python3");
    expect(s).toEqual({ "python.defaultInterpreterPath": "/nix/store/xyz/bin/python3" });
  });

  it("rejects keys that are not settings keys", () => {
    expect(parseFlakeSettings('{"notasetting":1,"ok.key":2}')).toEqual({ "ok.key": 2 });
  });

  it("malformed JSON costs the settings, not the devShell", () => {
    expect(parseFlakeSettings("{ this is not json")).toEqual({});
    expect(parseFlakeSettings("[1,2]"), "an array is not a settings object either").toEqual({});
  });

  it("a devShell that declares nothing applies nothing", () => {
    expect(collectSettings({})).toEqual({});
  });

  it("collects across the flake's settings variables", () => {
    const values = collectSettings({
      vscodeSettings: '{"a.b":"first","c.d":"flake"}',
      VSCODE_SETTINGS: '{"a.b":"second"}',
    });
    expect(values).toEqual({ "a.b": "second", "c.d": "flake" });
  });
});

describe("machine settings file", () => {
  it("writes into the devShell server's own machine settings", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    const result = await applyMachineSettings(dir, { "nix.serverPath": "/nix/store/a/bin/nil" });
    expect(result.written).toEqual(["nix.serverPath"]);
    const file = machineSettingsPath(dir);
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({ "nix.serverPath": "/nix/store/a/bin/nil" });
    expect(file, `unexpected location: ${file}`).toContain(path.join("data", "Machine"));
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("leaves settings it did not write alone", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    const file = machineSettingsPath(dir);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, '{ "editor.fontSize": 15 }');
    await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
      "editor.fontSize": 15,
      "nix.serverPath": "/a",
    });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("drops a key the flake has stopped declaring", async () => {
    // Otherwise deleting a line from the flake would leave its value behind forever.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    await applyMachineSettings(dir, { "nix.serverPath": "/a", "nix.formatterPath": "/b" });
    const result = await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    expect(result.removed).toEqual(["nix.formatterPath"]);
    expect(JSON.parse(await fs.readFile(machineSettingsPath(dir), "utf8"))).toEqual({ "nix.serverPath": "/a" });
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("an unchanged run does not rewrite the file", async () => {
    // Which is what keeps a user's own comments in it.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "nd-set-"));
    await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    const file = machineSettingsPath(dir);
    await fs.writeFile(file, '// mine\n{\n  "nix.serverPath": "/a",\n}\n');
    await applyMachineSettings(dir, { "nix.serverPath": "/a" });
    expect((await fs.readFile(file, "utf8")).startsWith("// mine"), "the comment must survive").toBe(true);
    await fs.rm(dir, { recursive: true, force: true });
  });

  it("a comment does not truncate a path containing //", () => {
    const parsed = parseJsonc('{\n  // ours\n  "a.b": "https://example.invalid/x" /* end */\n}');
    expect(parsed).toEqual({ "a.b": "https://example.invalid/x" });
  });

  it("tolerates a trailing comma, which settings.json allows", () => {
    expect(parseJsonc('{ "a.b": 1, }')).toEqual({ "a.b": 1 });
  });
});
