import fs from "fs";
import path from "path";

const LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type Level = (typeof LEVELS)[number];

export type Logger = {
  log: (entry: { level: Level; msg: string }) => void;
  logFile?: string;
};

function getLogger(ctx: { logDir?: string; logFile?: string; logLevel?: Level }): Logger {
  const minRank = LEVELS.indexOf(ctx.logLevel ?? "info");
  let fileStream: fs.WriteStream | null = null;
  let logFile: string | undefined;

  if (ctx.logFile) {
    logFile = ctx.logFile;
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fileStream = fs.createWriteStream(logFile, { flags: "a" });
  } else if (ctx.logDir) {
    fs.mkdirSync(ctx.logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    logFile = path.join(ctx.logDir, `proxy-${ts}.log`);
    fileStream = fs.createWriteStream(logFile, { flags: "a" });
  }

  function log({ level, msg }: { level: Level; msg: string }) {
    if (LEVELS.indexOf(level) > minRank) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
    fileStream?.write(line + "\n");
  }

  return { log, logFile };
}

export const logUtils = { getLogger };
