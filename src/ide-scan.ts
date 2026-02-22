import fs from "fs";
import path from "path";
import crypto from "crypto";
import { pathUtils } from "./path-utils.ts";

export type LockFile = {
  pid: number;
  workspaceFolders: string[];
  ideName: string;
  transport: string;
  runningInWindows: boolean;
  authToken: string;
};

function readAllLocks(claudeDir: string): Map<number, LockFile> {
  const result = new Map<number, LockFile>();
  if (!fs.existsSync(claudeDir)) return result;

  for (const file of fs.readdirSync(claudeDir)) {
    if (!file.endsWith(".lock")) continue;
    const port = parseInt(file.replace(".lock", ""), 10);
    if (isNaN(port)) continue;
    try {
      const content = fs.readFileSync(path.join(claudeDir, file), "utf-8");
      result.set(port, JSON.parse(content) as LockFile);
    } catch {
      // skip malformed lock files
    }
  }
  return result;
}

function writeLock(ctx: { claudeDir: string }, port: number, data: LockFile): void {
  fs.mkdirSync(ctx.claudeDir, { recursive: true });
  fs.writeFileSync(path.join(ctx.claudeDir, `${port}.lock`), JSON.stringify(data, null, 2), "utf-8");
}

function removeLock(ctx: { claudeDir: string }, port: number): void {
  const filePath = path.join(ctx.claudeDir, `${port}.lock`);
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
}

function generateAuthToken(): string {
  return crypto.randomUUID();
}

function findSubProjectIDEs(ctx: { claudeDir: string; monorepoRoot: string }): Map<number, LockFile> {
  const all = readAllLocks(ctx.claudeDir);
  const result = new Map<number, LockFile>();
  const normalRoot = pathUtils.normalizePath(ctx.monorepoRoot);

  for (const [port, lock] of all) {
    if (lock.ideName === "cc-elephant") continue;
    for (const folder of lock.workspaceFolders) {
      if (pathUtils.normalizePath(folder).startsWith(normalRoot + "/")) {
        result.set(port, lock);
        break;
      }
    }
  }
  return result;
}

function isUnderRoot(folder: string, monorepoRoot: string): boolean {
  return pathUtils.normalizePath(folder).startsWith(pathUtils.normalizePath(monorepoRoot) + "/");
}

export const ideScanUtils = { writeLock, removeLock, generateAuthToken, findSubProjectIDEs, isUnderRoot };
