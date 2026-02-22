import { pathUtils } from "./path-utils.ts";

export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: string | number;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

type Connection = { workspaceFolder: string };

function extractPaths(message: JsonRpcMessage): string[] {
  const json = JSON.stringify(message);
  const paths: string[] = [];

  for (const m of json.matchAll(/"([A-Za-z]:[/\\\\][^"]+)"/g)) {
    if (m[1]) paths.push(m[1].replace(/\\\\/g, "\\"));
  }

  for (const m of json.matchAll(/"(\/[a-zA-Z][^"]{2,})"/g)) {
    if (m[1]) paths.push(m[1]);
  }

  return paths;
}

function longestPrefixMatch<T extends Connection>(filePath: string, connections: T[]): T | undefined {
  const normalized = pathUtils.normalizePath(filePath);
  let best: T | undefined;
  let bestLen = 0;

  for (const c of connections) {
    const prefix = pathUtils.normalizePath(c.workspaceFolder) + "/";
    if (normalized.startsWith(prefix) && prefix.length > bestLen) {
      best = c;
      bestLen = prefix.length;
    }
  }

  return best;
}

function selectTargets<T extends Connection>(message: JsonRpcMessage, connections: T[]): T[] {
  if (connections.length === 0) return [];

  const paths = extractPaths(message);
  if (paths.length === 0) return connections;

  const targets = new Set<T>();

  for (const filePath of paths) {
    const match = longestPrefixMatch(filePath, connections);
    if (match) targets.add(match);
  }

  return targets.size > 0 ? [...targets] : connections;
}

export const routerUtils = { selectTargets };
