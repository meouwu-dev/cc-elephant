import type { ServerWebSocket } from "bun";
import { ideScanUtils } from "./ide-scan.ts";
import { routerUtils, type JsonRpcMessage } from "./router.ts";
import type { Logger } from "./logger.ts";
import { raiseWindow } from "./focus.ts";

type Ctx = {
  port: number;
  monorepoRoot: string;
  claudeDir: string;
  logger: Logger;
  autoFocus: boolean;
  debug: boolean;
};

type LiveConnection = {
  port: number;
  pid: number;
  workspaceFolder: string;
  subProjectName: string;
  authToken: string;
  ws: WebSocket;
};

type Session = {
  liveConns: LiveConnection[];
  messageBuffer: string[];
  ready: boolean;
  answered: Set<string | number>;
  // proxyId (e.g. "3456-1") → { originalId, conn }
  ideRequestMap: Map<
    string,
    { originalId: string | number; conn: LiveConnection }
  >;
};

function focusIdeWindow(conn: LiveConnection, ctx: Ctx): void {
  ctx.logger.log({
    level: "debug",
    msg: `trigger focus to ${conn.subProjectName}`,
  });
  raiseWindow(conn.pid);
}

function parseMessage(raw: string): JsonRpcMessage | null {
  try {
    return JSON.parse(raw) as JsonRpcMessage;
  } catch {
    return null;
  }
}

function makeProxyId(
  conn: LiveConnection,
  originalId: string | number,
): string {
  return `${conn.port}-${originalId}`;
}

function logJson(
  { from, to, message }: { from: string; to: string; message: JsonRpcMessage },
  ctx: Ctx,
): void {
  const level = message.method && "ping" !== message.method ? "debug" : "trace";
  ctx.logger.log({
    level,
    msg: `[${from}→${to}] ${JSON.stringify(message).slice(0, 200)}`,
  });
}

function forwardClaudeToIde(
  claudeWs: ServerWebSocket,
  session: Session,
  raw: string,
  ctx: Ctx,
): void {
  const message = parseMessage(raw);
  if (!message) {
    ctx.logger.log({
      level: "warn",
      msg: `Unparseable message from Claude: ${raw.slice(0, 200)}`,
    });
    return;
  }

  // Response to an IDE-originated request — restore original ID and route back to that IDE only
  if (message.id != null && session.ideRequestMap.has(message.id as string)) {
    const entry = session.ideRequestMap.get(message.id as string)!;
    session.ideRequestMap.delete(message.id as string);
    const finalPayload = { ...message, id: entry.originalId };
    const reply = JSON.stringify(finalPayload);
    if (entry.conn.ws.readyState === WebSocket.OPEN) {
      logJson(
        {
          from: "claude",
          to: entry.conn.subProjectName,
          message: finalPayload,
        },
        ctx,
      );
      entry.conn.ws.send(reply);
    }
    return;
  }

  const targets = routerUtils.selectTargets(message, session.liveConns);

  // No IDEs available — reject requests so Claude doesn't hang waiting for a response
  if (targets.length === 0 && message.id != null) {
    claudeWs.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: message.id,
        error: { code: -32000, message: "cc-elephant: no IDE connected" },
      }),
    );
    return;
  }

  for (const conn of targets) {
    if (conn.ws.readyState !== WebSocket.OPEN) continue;
    logJson({ from: "claude", to: conn.subProjectName, message }, ctx);
    conn.ws.send(raw);
  }

  const toolName =
    (message.params as { name?: string } | undefined)?.name ?? "";
  if (
    ctx.autoFocus &&
    message.method === "tools/call" &&
    toolName === "openDiff" &&
    targets.length > 0
  ) {
    const pids = new Set<number>();
    for (const conn of targets) {
      if (pids.has(conn.pid)) continue;
      pids.add(conn.pid);
      focusIdeWindow(conn, ctx);
    }
  }
}

function forwardIdeToClaude(
  claudeWs: ServerWebSocket,
  session: Session,
  conn: LiveConnection,
  raw: string,
  ctx: Ctx,
): void {
  const message = parseMessage(raw);
  if (!message) return;
  if (claudeWs.readyState !== WebSocket.OPEN) return;

  // Dedup responses to Claude-originated requests (multiple IDEs may respond to a broadcast)
  if (
    message.id != null &&
    !message.method &&
    (message.result !== undefined || message.error !== undefined)
  ) {
    if (session.answered.has(message.id)) return;
    session.answered.add(message.id);
  }

  // IDE-originated request: prefix ID with port to avoid collisions across IDEs
  if (message.id != null && message.method != null) {
    const proxyId = makeProxyId(conn, message.id);
    session.ideRequestMap.set(proxyId, { originalId: message.id, conn });
    const remappedMsg = { ...message, id: proxyId };
    logJson(
      { from: conn.subProjectName, to: "claude", message: remappedMsg },
      ctx,
    );
    claudeWs.send(JSON.stringify(remappedMsg));
    return;
  }

  logJson({ from: conn.subProjectName, to: "claude", message }, ctx);
  claudeWs.send(raw);
}

async function connectToIdes(
  claudeWs: ServerWebSocket,
  session: Session,
  ctx: Ctx,
): Promise<void> {
  const locks = ideScanUtils.findSubProjectIDEs(ctx);

  await Promise.allSettled(
    [...locks.entries()].flatMap(([port, lock]) =>
      lock.workspaceFolders
        .filter((f) => ideScanUtils.isUnderRoot(f, ctx.monorepoRoot))
        .map(
          (workspaceFolder) =>
            new Promise<void>((resolve, reject) => {
              const subProjectName =
                workspaceFolder.split(/[\\/]/).pop() ?? workspaceFolder;
              const ws = new WebSocket(`ws://127.0.0.1:${port}`, {
                protocols: ["mcp"],
                headers: { "x-claude-code-ide-authorization": lock.authToken },
              });

              ws.onopen = () => {
                const conn: LiveConnection = {
                  port,
                  pid: lock.pid,
                  workspaceFolder,
                  subProjectName,
                  authToken: lock.authToken,
                  ws,
                };
                session.liveConns.push(conn);
                ws.onmessage = (e) =>
                  forwardIdeToClaude(
                    claudeWs,
                    session,
                    conn,
                    e.data.toString(),
                    ctx,
                  );
                ws.onclose = (e) => {
                  ctx.logger.log({
                    level: "info",
                    msg: `${subProjectName} disconnected (code=${e.code})`,
                  });
                  session.liveConns = session.liveConns.filter(
                    (c) => c !== conn,
                  );
                };
                ctx.logger.log({
                  level: "info",
                  msg: `Connected to ${subProjectName} on port ${port}`,
                });
                resolve();
              };

              ws.onerror = () =>
                reject(
                  new Error(
                    `Failed to connect to ${subProjectName} port=${port}`,
                  ),
                );
              ws.onclose = (e) => {
                if (!session.liveConns.find((c) => c.ws === ws)) {
                  reject(
                    new Error(
                      `${subProjectName} closed before open (code=${e.code})`,
                    ),
                  );
                }
              };
            }),
        ),
    ),
  );

  // Yield so any immediate post-open closes (e.g. auth rejection) fire before we flush
  await new Promise((r) => setTimeout(r, 0));

  session.ready = true;
  for (const raw of session.messageBuffer)
    forwardClaudeToIde(claudeWs, session, raw, ctx);
  session.messageBuffer = [];

  ctx.logger.log({
    level: "info",
    msg: `${session.liveConns.length}/${locks.size} IDE(s) connected`,
  });
}

function handleClaudeOpen(
  ws: ServerWebSocket,
  sessions: Map<ServerWebSocket, Session>,
  ctx: Ctx,
): void {
  ctx.logger.log({ level: "info", msg: "Claude Code connected" });
  const session: Session = {
    liveConns: [],
    messageBuffer: [],
    ready: false,
    answered: new Set(),
    ideRequestMap: new Map(),
  };
  sessions.set(ws, session);
  connectToIdes(ws, session, ctx);
}

function handleClaudeMessage(
  ws: ServerWebSocket,
  data: string | Buffer,
  sessions: Map<ServerWebSocket, Session>,
  ctx: Ctx,
): void {
  const session = sessions.get(ws);
  if (!session) return;
  const raw = data.toString();
  if (!session.ready) {
    session.messageBuffer.push(raw);
    return;
  }
  forwardClaudeToIde(ws, session, raw, ctx);
}

function handleClaudeClose(
  ws: ServerWebSocket,
  code: number,
  sessions: Map<ServerWebSocket, Session>,
  ctx: Ctx,
): void {
  ctx.logger.log({
    level: "info",
    msg: `Claude Code disconnected (code=${code})`,
  });
  const session = sessions.get(ws);
  if (session) {
    for (const conn of session.liveConns) conn.ws.close();
    sessions.delete(ws);
  }
}

export function startProxy(
  ctx: Ctx,
  authToken: string,
): ReturnType<typeof Bun.serve> {
  const sessions = new Map<ServerWebSocket, Session>();

  return Bun.serve<undefined>({
    port: ctx.port,
    fetch(req, srv) {
      const token = req.headers.get("x-claude-code-ide-authorization") ?? "";
      if (token !== authToken)
        return new Response("Unauthorized", { status: 401 });
      srv.upgrade(req, { data: undefined });
      return undefined as unknown as Response;
    },
    websocket: {
      open: (ws) => handleClaudeOpen(ws, sessions, ctx),
      message: (ws, data) => handleClaudeMessage(ws, data, sessions, ctx),
      close: (ws, code) => handleClaudeClose(ws, code, sessions, ctx),
    },
  });
}
