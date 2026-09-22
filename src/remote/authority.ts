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
 * Separates the fields inside the encoded payload; cannot occur in a path or attr name.
 *
 * Spelled as an escape, not the character itself: a literal NUL byte makes `file`, `grep`
 * and `git grep` classify the whole source file as binary and skip it, silently.
 */
const SEP = "\u0000";

/**
 * A remote authority is `nix-devshell+<base32 payload>`, and the payload *is* the target.
 *
 * The resolver runs in a different window from the one that created the authority and is
 * handed nothing but this string.
 *
 * A URI authority is case-insensitive by RFC 3986.
 *
 * The folder path is already visible in the URI's path component, so encoding it here
 * exposes nothing new.
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
 * Recover the target an authority describes.
 *
 * Returns undefined rather than throwing for anything that is not one of ours: base64
 * decoding never fails loudly -- it happily turns nonsense into nonsense -- so the result
 * is validated rather than trusted. An authority minted by an older version used an opaque
 * digest and will simply not decode, which the caller reports as needing a fresh reopen.
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
 * A short, stable key for anything stored per authority: server data, the extension
 * directory, the lock file.
 *
 * The authority itself is unsuitable as a file name -- it grows with the folder path and a
 * deep enough checkout would exceed the 255-byte limit on a path component -- so it is
 * hashed down to something fixed-width.
 */
export function storageKeyFor(authority: string): string {
  return crypto
    .createHash("sha256")
    .update(authority)
    .digest("hex")
    .slice(0, 16);
}
