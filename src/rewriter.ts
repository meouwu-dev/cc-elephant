import { pathUtils } from "./path-utils.ts";

// Replaces all occurrences of fromRoot with toRoot in a raw JSON string.
// Handles both forward-slash and JSON-escaped backslash variants.
function rewrite(json: string, fromRoot: string, toRoot: string): string {
  const unixFrom = pathUtils.toUnixPath(fromRoot);
  const unixTo   = pathUtils.toUnixPath(toRoot);
  let result = json.split(unixFrom).join(unixTo);

  const winFrom = pathUtils.toJsonEscapedWinPath(fromRoot);
  const winTo   = pathUtils.toJsonEscapedWinPath(toRoot);
  if (winFrom !== unixFrom) {
    result = result.split(winFrom).join(winTo);
  }

  return result;
}

export const rewriterUtils = { rewrite };
