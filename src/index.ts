#!/usr/bin/env bun
import { parseArgs } from "util";
import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { logUtils, type Level } from "./logger.ts";
import { ideScanUtils } from "./ide-scan.ts";
import { startProxy } from "./proxy.ts";
import { pathUtils } from "./path-utils.ts";
import { setParentLspEnv, getLspLogFile, LSP_ENV_KEYS } from "./lsp-env.ts";

const rawArgs = process.argv.slice(2);
const sepIndex = rawArgs.indexOf("--");
const elephantArgs = sepIndex === -1 ? rawArgs : rawArgs.slice(0, sepIndex);
const claudeArgs = sepIndex === -1 ? [] : rawArgs.slice(sepIndex + 1);

const { values } = parseArgs({
  args: elephantArgs,
  options: {
    port: { type: "string" },
    "log-dir": { type: "string" },
    "log-level": { type: "string" },
    "auto-focus": { type: "boolean" },
    debug: { type: "boolean" },
    dir: { type: "string" },
    "proxy-only": { type: "boolean" },
    "lsp-fix": { type: "boolean" },
  },
  allowPositionals: false,
});

const proxyOnly = values["proxy-only"] ?? false;
const lspFix = values["lsp-fix"] ?? false;

const port = values.port
  ? parseInt(values.port, 10)
  : Math.floor(Math.random() * 10000) + 20000;
const monorepoRoot = values.dir
  ? pathUtils.normalizePath(values.dir)
  : process.cwd();
const claudeDir = path.join(os.homedir(), ".claude", "ide");
const debug = values["debug"] ?? false;

const dataDir = path.join(os.homedir(), ".cc-elephant");

function resolveLogDir(): string | undefined {
  if (values["log-dir"] === "") {
    return path.join(dataDir, "logs");
  }
  if (values["log-dir"] !== undefined) {
    return values["log-dir"];
  }
  if (debug) {
    return path.join(dataDir, "logs");
  }
  return undefined;
}
const logDir = resolveLogDir();
const logLevel =
  (values["log-level"] as Level | undefined) ?? (debug ? "debug" : "info");
const logger = logUtils.getLogger({ logDir, logLevel });

const autoFocus = values["auto-focus"] ?? false;
const ctx = { port, monorepoRoot, claudeDir, logger, autoFocus, debug };

const authToken = ideScanUtils.generateAuthToken();

ideScanUtils.writeLock(ctx, port, {
  pid: process.pid,
  workspaceFolders: [monorepoRoot],
  ideName: "cc-elephant",
  transport: "ws",
  runningInWindows: process.platform === "win32",
  authToken,
});

if (logger.logFile) {
  console.log(`logging to: ${logger.logFile}`);
  if (lspFix) {
    console.log(`lsp logging to: ${getLspLogFile(logger.logFile)}`);
  }
}

logger.log({ level: "info", msg: `monorepoRoot : ${monorepoRoot}` });
logger.log({ level: "info", msg: `port         : ${port}` });
logger.log({ level: "info", msg: `logDir       : ${logDir ?? "disabled"}` });
logger.log({ level: "info", msg: `logLevel     : ${logLevel}` });
logger.log({ level: "info", msg: `autoFocus    : ${autoFocus}` });
logger.log({ level: "info", msg: `debug        : ${debug}` });
logger.log({ level: "info", msg: `proxyOnly    : ${proxyOnly}` });
logger.log({ level: "info", msg: `lspFix       : ${lspFix}` });

const server = startProxy(ctx, authToken);

function shutdown() {
  ideScanUtils.removeLock(ctx, port);
  server.stop();
}

if (proxyOnly) {
  process.on("SIGINT", () => {
    shutdown();
    process.exit(0);
  });
  process.on("SIGTERM", () => {
    shutdown();
    process.exit(0);
  });
  process.on("exit", () => ideScanUtils.removeLock(ctx, port));
} else {
  // Spawn claude as a child process
  const env = { ...process.env };
  const LSP_SERVERS = ["typescript-language-server"];

  if (lspFix) {
    const wrapperPath = path.resolve(import.meta.dir, "lsp-wrapper.ts");
    const shimDir = path.join(dataDir, "shims", `${process.pid}`);
    fs.mkdirSync(shimDir, { recursive: true });

    for (const server of LSP_SERVERS) {
      if (process.platform === "win32") {
        const shimContent = `@echo off\nset "${LSP_ENV_KEYS.target}=${server}"\nset "${LSP_ENV_KEYS.shimDir}=${shimDir}"\nbun "${wrapperPath}" %*\n`;
        fs.writeFileSync(path.join(shimDir, `${server}.cmd`), shimContent);
      } else {
        const shimContent = `#!/bin/sh\nexport ${LSP_ENV_KEYS.target}="${server}"\nexport ${LSP_ENV_KEYS.shimDir}="${shimDir}"\nexec bun "${wrapperPath}" "$@"\n`;
        const shimPath = path.join(shimDir, server);
        fs.writeFileSync(shimPath, shimContent, { mode: 0o755 });
      }
    }

    const sep = process.platform === "win32" ? ";" : ":";
    env.PATH = `${shimDir}${sep}${env.PATH ?? ""}`;
    env.ENABLE_LSP_TOOL = "1";
    setParentLspEnv(env, { logFile: logger.logFile, logLevel });
    logger.log({
      level: "info",
      msg: `lsp-fix: generated shims in ${shimDir} for [${LSP_SERVERS.join(", ")}], set ENABLE_LSP_TOOL=1`,
    });
  }

  logger.log({ level: "info", msg: "spawning claude..." });

  logger.log({ level: "info", msg: `claudeArgs   : ${claudeArgs.join(" ")}` });

  const claude = spawn("claude", claudeArgs, {
    stdio: "inherit",
    env,
    shell: true,
  });

  claude.on("exit", (code) => {
    shutdown();
    process.exit(code ?? 0);
  });

  process.on("SIGINT", () => claude.kill("SIGINT"));
  process.on("SIGTERM", () => {
    claude.kill("SIGTERM");
    shutdown();
  });
}
