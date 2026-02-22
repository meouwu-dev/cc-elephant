import fs from "fs";
import path from "path";

const LEVELS = ["error", "warn", "info", "debug", "trace"] as const;
export type Level = (typeof LEVELS)[number];

export type Logger = {
  log: (entry: { level: Level; msg: string }) => void;
};

function getLogger(ctx: { logDir?: string; logLevel?: Level }): Logger {
  const minRank = LEVELS.indexOf(ctx.logLevel ?? "info");
  let fileStream: fs.WriteStream | null = null;

  if (ctx.logDir) {
    fs.mkdirSync(ctx.logDir, { recursive: true });
    const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const logFile = path.join(ctx.logDir, `proxy-${ts}.log`);
    fileStream = fs.createWriteStream(logFile, { flags: "a" });
  }

  function log({ level, msg }: { level: Level; msg: string }) {
    if (LEVELS.indexOf(level) > minRank) return;
    const line = `[${new Date().toISOString()}] [${level.toUpperCase().padEnd(5)}] ${msg}`;
    fileStream?.write(line + "\n");
    process.stdout.write(line + "\n");
  }

  return { log };
}

export const logUtils = { getLogger };
