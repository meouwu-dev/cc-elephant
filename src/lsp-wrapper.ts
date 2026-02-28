#!/usr/bin/env bun

/**
 * Stdio JSON-RPC proxy for typescript-language-server.
 * Intercepts messages in both directions and normalizes file:// URIs
 * so backslash Windows paths become proper forward-slash URIs.
 */

import { spawn } from "child_process";
import path from "path";
import fs from "fs";

const DEBUG = !!process.env.CCE_LSP_DEBUG;
const LOG_DIR = process.env.CCE_LOG_DIR;
const LOG_FILE = LOG_DIR ? path.join(LOG_DIR, "cc-elephant.log") : undefined;

function debug(msg: string) {
  const line = `[cce-lsp-wrapper ${new Date().toISOString()}] ${msg}\n`;
  if (DEBUG) process.stderr.write(line);
  if (LOG_FILE) {
    try {
      fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true });
      fs.appendFileSync(LOG_FILE, line);
    } catch {}
  }
}

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

// --- Find the real typescript-language-server ---

function findRealTLS(selfDir: string): string {
  const envPath = process.env.PATH ?? "";
  const sep = process.platform === "win32" ? ";" : ":";
  const dirs = envPath.split(sep);
  const exeName = "typescript-language-server";
  const candidates = process.platform === "win32"
    ? [`${exeName}.cmd`, `${exeName}.bat`, `${exeName}.exe`, exeName]
    : [exeName];

  for (const dir of dirs) {
    const normalized = path.resolve(dir);
    if (normalized === path.resolve(selfDir)) continue;
    for (const candidate of candidates) {
      const full = path.join(dir, candidate);
      try {
        fs.accessSync(full, fs.constants.X_OK);
        debug(`found real TLS: ${full}`);
        return full;
      } catch {
        // not here
      }
    }
  }

  throw new Error(
    "Could not find real typescript-language-server on PATH (excluding wrapper shim dir)"
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

debug(`lsp-wrapper invoked with args: ${process.argv.slice(2).join(" ")}`);

const selfDir = path.resolve(path.dirname(process.argv[1] ?? __filename), "bin");

const realTLS = findRealTLS(selfDir);
const childArgs = process.argv.slice(2);

debug(`spawning: ${realTLS} ${childArgs.join(" ")}`);

const child = spawn(realTLS, childArgs, {
  stdio: ["pipe", "pipe", "inherit"],
});

// stdin → child: normalize URIs in requests
const stdinFramer = new JsonRpcFramer((body) => {
  const normalized = normalizeUris(body);
  if (DEBUG && normalized !== body) {
    debug(`stdin rewrite:\n  before: ${body.substring(0, 200)}\n  after:  ${normalized.substring(0, 200)}`);
  }
  child.stdin.write(encodeMessage(normalized));
});

process.stdin.on("data", (chunk: Buffer) => stdinFramer.feed(chunk));
process.stdin.on("end", () => child.stdin.end());

// child stdout → stdout: normalize URIs in responses
const stdoutFramer = new JsonRpcFramer((body) => {
  const normalized = normalizeUris(body);
  if (DEBUG && normalized !== body) {
    debug(`stdout rewrite:\n  before: ${body.substring(0, 200)}\n  after:  ${normalized.substring(0, 200)}`);
  }
  process.stdout.write(encodeMessage(normalized));
});

child.stdout.on("data", (chunk: Buffer) => stdoutFramer.feed(chunk));

child.on("exit", (code) => process.exit(code ?? 1));
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
