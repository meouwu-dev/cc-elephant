import type { Level } from "./logger.ts";

export const LSP_ENV_KEYS = {
  logFile: "CCE_LOG_FILE",
  logLevel: "CCE_LOG_LEVEL",
  target: "CCE_LSP_TARGET",
  shimDir: "CCE_LSP_SHIM_DIR",
} as const;

export interface ParentLspEnv {
  logFile?: string;
  logLevel: Level;
}

export interface ShimLspEnv {
  target: string;
  shimDir: string;
}

export type LspEnv = ParentLspEnv & ShimLspEnv;

export function setParentLspEnv(env: Record<string, string | undefined>, config: ParentLspEnv) {
  if (config.logFile) env[LSP_ENV_KEYS.logFile] = config.logFile;
  env[LSP_ENV_KEYS.logLevel] = config.logLevel;
}

export function getLspLogFile(logFile: string): string {
  return logFile.replace(/\.log$/, "-lsp.log");
}

export function getLspEnv(): LspEnv {
  const target = process.env[LSP_ENV_KEYS.target];
  if (!target) {
    process.stderr.write(`${LSP_ENV_KEYS.target} env var is not set\n`);
    process.exit(1);
  }
  return {
    logFile: process.env[LSP_ENV_KEYS.logFile],
    logLevel: (process.env[LSP_ENV_KEYS.logLevel] as Level) ?? "debug",
    target,
    shimDir: process.env[LSP_ENV_KEYS.shimDir] ?? "",
  };
}
