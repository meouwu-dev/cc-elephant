#!/usr/bin/env bun

/**
 * Stdio JSON-RPC proxy for typescript-language-server.
 * Intercepts messages in both directions and normalizes file:// URIs
 * so backslash Windows paths become proper forward-slash URIs.
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";
import { logUtils } from "./logger.ts";
import { getLspEnv, getLspLogFile } from "./lsp-env.ts";

const lspEnv = getLspEnv();
const lspLogFile = lspEnv.logFile ? getLspLogFile(lspEnv.logFile) : undefined;

const logger = logUtils.getLogger({
  logFile: lspLogFile,
  logLevel: lspEnv.logLevel,
});

// --- URI normalization ---

const FILE_URI_RE = /file:\/\/\/?[A-Za-z][:%]?[\\\/]/g;

function normalizeFileUri(uri: string): string {
  return uri.replace(FILE_URI_RE, (match) => {
    // Strip the file:// prefix, normalize slashes, ensure triple-slash
    let rest = match.replace(/^file:\/\/\/?/, "");
    rest = rest.replace(/\\/g, "/");
    rest = rest.replace(/\/\/+/g, "/");
    rest = rest.replace(/%3[Aa]/, ":");
    return `file:///${rest}`;
  });
}

// Full pass over a string — catches URIs embedded in JSON string values
function normalizeUris(text: string): string {
  return text.replace(
    /file:\/\/\/?[A-Za-z](?:[:%][A-Fa-f0-9]{0,2})?[\\\/][^\s"')}\]>]*/g,
    (uri) => {
      let normalized = uri.replace(/^file:\/\/\/?/, "");
      normalized = normalized.replace(/\\/g, "/");
      normalized = normalized.replace(/\/\/+/g, "/");
      normalized = normalized.replace(/%3[Aa]/, ":");
      return `file:///${normalized}`;
    }
  );
}

// --- Find the real LSP server ---

function findRealServer(serverName: string, shimDir: string): string {
  const envPath = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = envPath.split(sep);
  const candidates = process.platform === "win32"
    ? [`${serverName}.cmd`, `${serverName}.bat`, `${serverName}.exe`, serverName]
    : [serverName];

  for (const dir of dirs) {
    const normalized = path.resolve(dir);
    if (normalized === path.resolve(shimDir)) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        logger.log({ level: "info", msg: `found real ${serverName}: ${full}` });
        return full;
      } catch {
        // not here
      }
    }
  }

  throw new Error(
    `Could not find real ${serverName} on PATH (excluding wrapper shim dir)`
  );
}

// --- JSON-RPC content-length framing ---

class JsonRpcFramer {
  private buffer = Buffer.alloc(0);
  private onMessage: (raw: string) => void;

  constructor(onMessage: (raw: string) => void) {
    this.onMessage = onMessage;
  }

  feed(chunk: Buffer) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    while (this.tryParse()) {}
  }

  private tryParse(): boolean {
    const headerEnd = this.buffer.indexOf("\r\n\r\n");
    if (headerEnd === -1) return false;

    const header = this.buffer.subarray(0, headerEnd).toString("ascii");
    const match = header.match(/Content-Length:\s*(\d+)/i);
    if (!match) {
      // Skip malformed header
      this.buffer = this.buffer.subarray(headerEnd + 4);
      return true;
    }

    const contentLength = parseInt(match[1]!, 10);
    const bodyStart = headerEnd + 4;
    if (this.buffer.length < bodyStart + contentLength) return false;

    const body = this.buffer.subarray(bodyStart, bodyStart + contentLength).toString("utf8");
    this.buffer = this.buffer.subarray(bodyStart + contentLength);
    this.onMessage(body);
    return true;
  }
}

function encodeMessage(body: string): Buffer {
  const content = Buffer.from(body, "utf8");
  const header = `Content-Length: ${content.length}\r\n\r\n`;
  return Buffer.concat([Buffer.from(header, "ascii"), content]);
}

// --- Main ---

logger.log({ level: "info", msg: `lsp-wrapper invoked for ${lspEnv.target} with args: ${process.argv.slice(2).join(" ")}` });

const shimDir = lspEnv.shimDir || path.dirname(process.argv[1] ?? __filename);

const realServer = findRealServer(lspEnv.target, shimDir);
const childArgs = process.argv.slice(2);

logger.log({ level: "info", msg: `spawning: ${realServer} ${childArgs.join(" ")}` });

const child = spawn(realServer, childArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});

// stdin → child: normalize URIs in requests
const stdinFramer = new JsonRpcFramer((body) => {
  const normalized = normalizeUris(body);
  if (normalized !== body) {
    logger.log({ level: "debug", msg: `stdin rewrite:\n  before: ${body}\n  after:  ${normalized}` });
  }
  child.stdin.write(encodeMessage(normalized));
});

process.stdin.on("data", (chunk: Buffer) => stdinFramer.feed(chunk));
process.stdin.on("end", () => child.stdin.end());

// child stdout → stdout: normalize URIs in responses
const stdoutFramer = new JsonRpcFramer((body) => {
  const normalized = normalizeUris(body);
  if (normalized !== body) {
    logger.log({ level: "debug", msg: `stdout rewrite:\n  before: ${body}\n  after:  ${normalized}` });
  }
  process.stdout.write(encodeMessage(normalized));
});

child.stdout.on("data", (chunk: Buffer) => stdoutFramer.feed(chunk));

child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
