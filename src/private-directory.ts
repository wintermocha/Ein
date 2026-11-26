import { lstatSync, mkdirSync } from "node:fs";
import { SetupError } from "./config";

/** Create a single leaf under a trusted parent, or verify the one already there. */
export function ensurePrivateDirectory(path: string): string {
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
  }
  const info = lstatSync(path);
  if (!info.isDirectory() || (info.mode & 0o077) !== 0 || info.uid !== process.getuid?.()) {
    throw new SetupError("Session data requires a private directory owned by the current user (chmod 700).");
  }
  return path;
}
