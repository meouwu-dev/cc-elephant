function normalizePath(p: string): string {
  return toUnixPath(p)
    .replace(/^([A-Za-z]):/, (_, d: string) => d.toLowerCase() + ":")
    .replace(/\/$/, "");
}

function toUnixPath(p: string): string {
  return p.replace(/\\/g, "/");
}

function toJsonEscapedWinPath(p: string): string {
  return p.replace(/\//g, "\\").replace(/\\/g, "\\\\");
}

export const pathUtils = { normalizePath, toUnixPath, toJsonEscapedWinPath };
