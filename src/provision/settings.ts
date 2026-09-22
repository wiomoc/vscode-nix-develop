import * as fs from "node:fs/promises";
import * as path from "node:path";
import { log } from "./log";

/** Editor settings, as in a `settings.json`. Not in `config.ts`, which imports `vscode`. */
export type SettingsMap = Record<string, unknown>;

/**
 * Per-devShell editor settings, so tool paths like `nix.serverPath` can point into the
 * devShell. Declared like `vscodeExtensions`, as a JSON string on `mkShell`:
 *
 *     pkgs.mkShell {
 *       packages = [ pkgs.nil ];
 *       vscodeSettings = builtins.toJSON {
 *         "nix.serverPath" = "${pkgs.nil}/bin/nil";
 *         "nix.enableLanguageServer" = true;
 *       };
 *     }
 *
 * `key=value` lines are accepted too.
 *
 * The values go into the server's per-devShell machine settings ("Remote [devShell]"),
 * which override user settings but yield to the workspace's `.vscode/settings.json`.
 */
const FLAKE_SETTINGS_VARS = ["vscodeSettings", "VSCODE_SETTINGS"];

/** A plausible settings key: dotted (`nix.serverPath`) or a language override (`[nix]`). */
const SETTING_KEY =
  /^(\[[A-Za-z0-9_+#.-]+\]|[A-Za-z0-9][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)+)$/;

/**
 * Parse one `vscodeSettings` value: a JSON object, or `key=value` lines. A line whose
 * words are all `key=value` (a Nix list) is several settings; otherwise the value may
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

/** `true`, `42` and `["a"]` are parsed as JSON; anything else stays a string. */
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

/** The settings the devShell declares, with later variables winning over earlier ones. */
export function collectSettings(
  devShellEnv: Record<string, string | undefined>,
): SettingsMap {
  const values: SettingsMap = {};
  for (const name of FLAKE_SETTINGS_VARS) {
    const raw = devShellEnv[name];
    if (!raw) continue;
    Object.assign(values, parseFlakeSettings(raw, name));
  }
  return values;
}

/** The server's machine settings file, under its per-devShell `--server-data-dir`. */
export function machineSettingsPath(serverDataDir: string): string {
  return path.join(serverDataDir, "data", "Machine", "settings.json");
}

/** Keys written on the last run, so ones the flake has dropped can be removed again. */
function managedPath(serverDataDir: string): string {
  return path.join(serverDataDir, "data", "Machine", "nix-devshell.managed.json");
}

/** Parse JSON with comments; string-aware, so a `//` inside a URL survives. */
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
 * The current machine settings: `{}` when missing, `undefined` when unreadable, so a
 * caller never overwrites contents it could not see.
 */
async function readMachineSettings(
  serverDataDir: string,
): Promise<SettingsMap | undefined> {
  const file = machineSettingsPath(serverDataDir);
  try {
    return parseJsonc(await fs.readFile(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return {};
    log.warn(`devShell settings at ${file} are unreadable (${(err as Error).message})`);
    return undefined;
  }
}

/**
 * Put the declared settings into the machine settings file. Other keys belong to the
 * user and are kept; keys the flake no longer declares are removed. The file is only
 * rewritten when its values change.
 */
export async function applyMachineSettings(
  serverDataDir: string,
  values: SettingsMap,
): Promise<{ written: string[]; removed: string[] }> {
  const file = machineSettingsPath(serverDataDir);
  const marker = managedPath(serverDataDir);

  const existing = await readMachineSettings(serverDataDir);
  if (existing === undefined) {
    log.warn(`not applying devShell settings: ${file} is unreadable`);
    return { written: [], removed: [] };
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

  // Compared as values, so an unchanged file keeps the user's formatting and comments.
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

/**
 * Write the devShell's declared settings before the server starts. Failures are logged,
 * never fatal.
 */
export async function applyDeclaredSettings(opts: {
  serverDataDir: string;
  devShellEnv: Record<string, string | undefined>;
}): Promise<void> {
  const values = collectSettings(opts.devShellEnv);
  const keys = Object.keys(values);
  if (keys.length > 0) {
    log.info(`devShell settings -- from flake: [${keys.join(", ")}]`);
  }
  await applyMachineSettings(opts.serverDataDir, values).catch((err) =>
    log.warn(
      `could not apply the devShell's settings: ${(err as Error).message}`,
    ),
  );
}
