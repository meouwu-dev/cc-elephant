#!/usr/bin/env bun
import { parseArgs } from "util";
import os from "os";
import path from "path";
import { logUtils, type Level } from "./logger.ts";
import { ideScanUtils } from "./ide-scan.ts";
import { startProxy } from "./proxy.ts";
import { pathUtils } from "./path-utils.ts";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    port: { type: "string" },
    "log-dir": { type: "string" },
    "log-level": { type: "string" },
    "auto-focus": { type: "boolean" },
    "debug": { type: "boolean" },
    dir: { type: "string" },
  },
  allowPositionals: false,
});

const port = values.port
  ? parseInt(values.port, 10)
  : Math.floor(Math.random() * 10000) + 20000;
const monorepoRoot = values.dir
  ? pathUtils.normalizePath(values.dir)
  : process.cwd();
const claudeDir = path.join(os.homedir(), ".claude", "ide");
const logDir =
  values["log-dir"] !== undefined
    ? values["log-dir"] === ""
      ? path.join(monorepoRoot, ".elephant")
      : values["log-dir"]
    : undefined;

const debug = values["debug"] ?? false;
const logLevel = (values["log-level"] as Level | undefined) ?? (debug ? "debug" : "info");
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

logger.log({ level: "info", msg: `monorepoRoot : ${monorepoRoot}` });
logger.log({ level: "info", msg: `port         : ${port}` });
logger.log({ level: "info", msg: `logDir       : ${logDir ?? "disabled"}` });
logger.log({ level: "info", msg: `logLevel     : ${logLevel}` });
logger.log({ level: "info", msg: `autoFocus    : ${autoFocus}` });
logger.log({ level: "info", msg: `debug        : ${debug}` });

const server = startProxy(ctx, authToken);

function shutdown() {
  ideScanUtils.removeLock(ctx, port);
  server.stop();
  process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
process.on("exit", () => ideScanUtils.removeLock(ctx, port));
