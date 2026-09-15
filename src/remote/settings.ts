import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { NixDevelopConfig, SettingsMap } from "../config";
import { log } from "../utils/log";

/**
 * Per-devShell editor settings.
 *
 * The companion of per-devShell extensions: an extension pinned by the flake is of little
 * use if the editor still points at a binary from the host. A devShell knows where its own
 * tools live, so it can say so -- `nix.serverPath`, `rust-analyzer.server.path`,
 * `python.defaultInterpreterPath` -- and the setting is then as reproducible as the
 * toolchain it names.
 *
 * Two ways to declare them, mirroring `vscodeExtensions`:
 *
 *  1. `nixDevelop.remote.settings` in workspace settings -- the per-checkout tweak, and the
 *     winner when both name the same key.
 *
 *  2. The devShell itself, through a `vscodeSettings` attribute on `mkShell`. Derivation
 *     attributes are strings, so an attrset has to be spelled as JSON:
 *
 *         pkgs.mkShell {
 *           packages = [ pkgs.nil ];
 *           vscodeSettings = builtins.toJSON {
 *             "nix.serverPath" = "${pkgs.nil}/bin/nil";
 *             "nix.enableLanguageServer" = true;
 *           };
 *         }
 *
 *     A `key=value` line per setting is accepted too, which is what a plain Nix list or a
 *     multi-line string yields.
 *
 * The values land in the *server's* machine settings file, which is per devShell for the
 * same reason the extension directory is: it lives under `--server-data-dir`. That is the
 * file VS Code shows as "Remote [devShell]" settings, and it outranks user settings while
 * still yielding to the workspace's own `.vscode/settings.json` -- so a devShell can point
 * the editor at its toolchain without the repository having to carry machine-specific
 * paths, and without anything being written into the workspace.
 */
export const FLAKE_SETTINGS_VARS = ["vscodeSettings", "VSCODE_SETTINGS"];

/**
 * A settings key: dotted (`nix.serverPath`) or a language override (`[nix]`).
 *
 * The point is not to know VS Code's settings -- extensions contribute their own -- but to
 * refuse anything that plainly is not one, so a stray word in the environment variable is
 * reported rather than written into the editor's configuration.
 */
const SETTING_KEY =
  /^(\[[A-Za-z0-9_+#.-]+\]|[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+)$/;

export interface SettingsSources {
  /** From `nixDevelop.remote.settings`. */
  fromSettings: SettingsMap;
  /** From the devShell's own environment. */
  fromFlake: SettingsMap;
}

/**
 * Parse one `vscodeSettings` value.
 *
 * JSON is the form to reach for -- `builtins.toJSON` renders any attrset, nested values
 * included. The `key=value` form exists because Nix makes strings out of everything else:
 * a list arrives space-separated on one line, a multi-line string arrives as it was
 * written, and both should mean the obvious thing. A line whose words are *all* `key=value`
 * is therefore read as several settings; otherwise it is one setting whose value may
 * contain spaces.
 */
export function parseFlakeSettings(raw: string, source = "vscodeSettings"): SettingsMap {
  const text = raw.trim();
  if (!text) return {};

  if (text.startsWith("{")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      log.warn(`ignoring ${source}: not valid JSON (${(err as Error).message})`);
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      log.warn(`ignoring ${source}: JSON must be an object of settings`);
      return {};
    }
    return validate(parsed as SettingsMap, source);
  }

  const pairs: SettingsMap = {};
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const words = trimmed.split(/\s+/);
    const parts = words.length > 1 && words.every((w) => w.includes("=")) ? words : [trimmed];
    for (const part of parts) {
      const at = part.indexOf("=");
      if (at <= 0) {
        log.warn(`ignoring '${part}' from ${source}: expected key=value or a JSON object`);
        continue;
      }
      pairs[part.slice(0, at).trim()] = scalar(part.slice(at + 1).trim());
    }
  }
  return validate(pairs, source);
}

/**
 * `true`, `42` and `["a"]` mean what they say; anything else is the string it looks like.
 *
 * Store paths are the common case here and must survive verbatim, so a failed parse is not
 * an error -- it is the answer.
 */
function scalar(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function validate(values: SettingsMap, source: string): SettingsMap {
  const out: SettingsMap = {};
  for (const [key, value] of Object.entries(values)) {
    if (!SETTING_KEY.test(key)) {
      log.warn(`ignoring '${key}' from ${source}: not a settings key`);
      continue;
    }
    if (value === undefined) continue;
    out[key] = value;
  }
  return out;
}

export function collectSettings(
  cfg: NixDevelopConfig,
  devShellEnv: Record<string, string>,
): SettingsSources {
  const fromFlake: SettingsMap = {};
  if (cfg.remote.settingsFromFlake) {
    for (const name of FLAKE_SETTINGS_VARS) {
      const raw = devShellEnv[name];
      if (!raw) continue;
      Object.assign(fromFlake, parseFlakeSettings(raw, name));
    }
  }
  return { fromSettings: validate(cfg.remote.settings ?? {}, "nixDevelop.remote.settings"), fromFlake };
}

/**
 * Workspace settings win: the flake describes the devShell in general, while
 * `nixDevelop.remote.settings` is what this checkout says about it.
 */
export function mergedSettings(sources: SettingsSources): SettingsMap {
  return { ...sources.fromFlake, ...sources.fromSettings };
}

/**
 * The server's machine settings file.
 *
 * `--server-data-dir <dir>` makes `<dir>/data` the server's user-data directory, and VS
 * Code reads machine settings from `Machine/settings.json` inside it. Since the data
 * directory is chosen per devShell, so is this file.
 */
export function machineSettingsPath(serverDataDir: string): string {
  return path.join(serverDataDir, "data", "Machine", "settings.json");
}

/** Keys written on the last run, so ones the flake has dropped can be removed again. */
function managedPath(serverDataDir: string): string {
  return path.join(serverDataDir, "data", "Machine", "nix-develop.managed.json");
}

/**
 * Read a settings file that VS Code may also have written.
 *
 * It is JSON with comments, and the comments are the user's: the file is editable from the
 * "Remote" settings tab. Stripping them has to be string-aware, or a `//` inside a path or
 * URL would truncate the line.
 */
export function parseJsonc(text: string): SettingsMap {
  let out = "";
  let inString = false;
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (inString) {
      out += ch;
      if (ch === "\\" && i + 1 < text.length) {
        out += text[i + 1];
        i += 2;
        continue;
      }
      if (ch === '"') inString = false;
      i++;
      continue;
    }
    if (ch === '"') {
      inString = true;
      out += ch;
      i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // Trailing commas are legal in settings.json and not in JSON.
  const stripped = out.replace(/,(\s*[}\]])/g, "$1").trim();
  if (!stripped) return {};
  const parsed = JSON.parse(stripped);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {};
  return parsed as SettingsMap;
}

/**
 * Put the declared settings into this devShell's machine settings file.
 *
 * Only the keys we declared are ours. Everything else in the file was put there by the
 * user -- the file is reachable from the settings UI as "Remote [devShell]" -- and is left
 * alone, including keys we wrote on an earlier run and the flake still declares. Keys the
 * flake has *stopped* declaring are removed, which is what makes deleting a line from the
 * flake take effect rather than leaving the old value behind forever.
 *
 * The file is only rewritten when the result differs, so a run that changes nothing also
 * preserves whatever comments the user's own edits left in it.
 */
export async function applyMachineSettings(
  serverDataDir: string,
  values: SettingsMap,
): Promise<{ written: string[]; removed: string[] }> {
  const file = machineSettingsPath(serverDataDir);
  const marker = managedPath(serverDataDir);

  let existing: SettingsMap = {};
  try {
    existing = parseJsonc(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
      // Rewriting a file we could not read would discard settings the user can see in the
      // UI, which is worse than the devShell's settings not being applied.
      log.warn(`not applying devShell settings: ${file} is unreadable (${(err as Error).message})`);
      return { written: [], removed: [] };
    }
  }

  let managed: string[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(marker, "utf8"));
    if (Array.isArray(parsed)) managed = parsed.filter((k): k is string => typeof k === "string");
  } catch {
    /* first run, or the marker was removed with the settings file */
  }

  const next: SettingsMap = { ...existing };
  const removed: string[] = [];
  for (const key of managed) {
    if (!(key in values) && key in next) {
      delete next[key];
      removed.push(key);
    }
  }
  const written = Object.keys(values);
  Object.assign(next, values);

  if (written.length === 0 && removed.length === 0 && managed.length === 0) {
    return { written: [], removed: [] };
  }

  // Compared as values, not as text: the file is editable from the settings UI, and a run
  // that changes nothing should leave the user's own formatting and comments intact.
  if (JSON.stringify(next) !== JSON.stringify(existing)) {
    const body = `${JSON.stringify(next, null, 2)}\n`;
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    log.info(
      `devShell settings -> ${file}: ${written.length} applied` +
        (removed.length > 0 ? `, ${removed.length} no longer declared` : ""),
    );
  }

  if (written.length > 0) await fs.writeFile(marker, `${JSON.stringify(written, null, 2)}\n`);
  else await fs.rm(marker, { force: true });

  return { written, removed };
}
