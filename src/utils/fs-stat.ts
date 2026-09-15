import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import path from "node:path";

export function exists(p: string): Promise<boolean> {
  return fsPromises
    .access(p)
    .then(() => true)
    .catch(() => false);
}

export function isDirectory(dirEntry: fs.Dirent): boolean | Promise<boolean> {
  if (dirEntry.isDirectory()) return true;
  if (dirEntry.isSymbolicLink()) {
      return fsPromises.stat(path.join(dirEntry.path, dirEntry.name)).then((stat) => stat.isDirectory()).catch(() => false);
  }
  return false;
}
