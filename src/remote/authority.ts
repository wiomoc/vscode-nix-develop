import * as crypto from "node:crypto";
import * as path from "node:path";
import { decodeBase32, encodeBase32 } from "../utils/base32";

/** The `authorityPrefix` passed to `registerRemoteAuthorityResolver`. */
export const AUTHORITY_PREFIX = "nix-devshell";

export interface RemoteTarget {
  /** Absolute path of the folder to open in the remote window. */
  folder: string;
  /** Absolute path of the directory holding flake.nix. */
  flakeDir: string;
  /** The devShell attribute name or full installable. */
  devShell: string;
}

/**
 * Separates the payload's fields; cannot occur in a path or attr name. An escape, since a
 * literal NUL makes `grep` treat this file as binary.
 */
const SEP = "\u0000";

/**
 * `nix-devshell+<base32 payload>`, where the payload is the whole target: the resolver
 * gets nothing but this string. Base32, because authorities are case-insensitive.
 */
export function authorityFor(target: RemoteTarget): string {
  const parts = [target.folder, target.devShell];
  // Only carried when it differs, which keeps the common authority shorter.
  if (target.flakeDir !== target.folder) parts.push(target.flakeDir);
  return `${AUTHORITY_PREFIX}+${encodeBase32(Buffer.from(parts.join(SEP), "utf8"))}`;
}

/** The payload of an authority: everything after the first `+`. */
export function authorityId(authority: string): string {
  const plus = authority.indexOf("+");
  return plus === -1 ? authority : authority.slice(plus + 1);
}

/**
 * Recover the target an authority describes, or `undefined` for anything that does not
 * decode and validate (including older opaque-digest authorities).
 */
export function decodeAuthority(authority: string): RemoteTarget | undefined {
  const payload = authorityId(authority).toLowerCase();
  if (!payload || !/^[a-z2-7]+$/.test(payload)) return undefined;

  const bytes = decodeBase32(payload);
  if (!bytes) return undefined;
  const decoded = bytes.toString("utf8");
  // A lossy decode (invalid UTF-8) shows up as
  // replacement characters; those never belong in a path we are about to act on.
  if (decoded.includes("\uFFFD")) return undefined;

  const parts = decoded.split(SEP);
  if (parts.length < 2 || parts.length > 3) return undefined;

  const [folder, devShell, flakeDir] = parts;
  if (!folder || !devShell) return undefined;
  if (!path.isAbsolute(folder)) return undefined;
  if (flakeDir !== undefined && !path.isAbsolute(flakeDir)) return undefined;

  // Field order matches RemoteTarget, so a decoded target compares equal to the original.
  return { folder, flakeDir: flakeDir || folder, devShell };
}

/**
 * A fixed-width key for per-authority storage (server data, extensions, lock). The
 * authority itself can exceed the 255-byte file name limit.
 */
export function storageKeyFor(authority: string): string {
  return crypto
    .createHash("sha256")
    .update(authority)
    .digest("hex")
    .slice(0, 16);
}
