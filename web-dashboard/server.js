import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "public");
const repoRoot = path.resolve(__dirname, "..");

const DASHBOARD_PORT = Number(process.env.PORT || process.env.DASHBOARD_PORT || 5173);
const DASHBOARD_HOST = process.env.DASHBOARD_HOST || (process.env.PORT ? "0.0.0.0" : "127.0.0.1");
const REDIS_HOST = process.env.MINI_REDIS_HOST || "127.0.0.1";
const REDIS_PORT = Number(process.env.MINI_REDIS_PORT || 8080);
const TCP_TIMEOUT_MS = Number(process.env.MINI_REDIS_TIMEOUT_MS || 1500);
const AUTOSTART_BACKEND = process.env.MINI_REDIS_AUTOSTART === "1";

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
  [".ico", "image/x-icon"]
]);

const trackedKeys = new Map();
const sessions = new Map();
const activityLog = [];
const MAX_ACTIVITY = 80;
let backendProcess = null;

function startBundledMiniRedis() {
  if (!AUTOSTART_BACKEND) return;

  const backendDir = path.join(repoRoot, "MiniRedis");
  const backendBinary = path.join(backendDir, "app");

  backendProcess = spawn(backendBinary, [], {
    cwd: backendDir,
    stdio: ["ignore", "pipe", "pipe"]
  });

  backendProcess.stdout.on("data", (chunk) => {
    process.stdout.write(`[mini-redis] ${chunk}`);
  });

  backendProcess.stderr.on("data", (chunk) => {
    process.stderr.write(`[mini-redis] ${chunk}`);
  });

  backendProcess.on("error", (error) => {
    backendProcess = null;
    console.error(`Failed to start Mini Redis backend at ${backendBinary}: ${error.message}`);
  });

  backendProcess.on("exit", (code, signal) => {
    backendProcess = null;
    console.log(`Mini Redis backend exited with code ${code ?? "null"} and signal ${signal ?? "null"}`);
  });
}

function stopBundledMiniRedis() {
  if (!backendProcess) return;
  backendProcess.kill("SIGTERM");
}

function normalizeCommand(command) {
  return String(command || "").replace(/\r?\n/g, " ").trim();
}

function tokenize(command) {
  return normalizeCommand(command).split(/\s+/).filter(Boolean);
}

function isLikelyWrite(tokens) {
  return ["SET", "DEL", "INCR", "DECR"].includes(tokens[0]?.toUpperCase());
}

function rememberCommand(command) {
  const tokens = tokenize(command);
  const op = tokens[0]?.toUpperCase();
  const key = tokens[1];
  if (!op || !key) return;

  if (op === "SET") {
    const exIndex = tokens.findIndex((token) => token.toUpperCase() === "EX");
    const ttlSeconds = exIndex >= 0 ? Number(tokens[exIndex + 1]) : null;
    trackedKeys.set(key, {
      key,
      lastCommand: command,
      updatedAt: Date.now(),
      expiresAt: Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null
    });
  }

  if (op === "DEL") {
    trackedKeys.delete(key);
  }

  if ((op === "INCR" || op === "DECR") && !trackedKeys.has(key)) {
    trackedKeys.set(key, {
      key,
      lastCommand: command,
      updatedAt: Date.now(),
      expiresAt: null
    });
  }
}

function rememberSnapshotLine(line, source) {
  const tokens = tokenize(line);
  if (tokens.length < 2) return;

  const [key] = tokens;
  const exIndex = tokens.findIndex((token) => token.toUpperCase() === "EX");
  const ttlSeconds = exIndex >= 0 ? Number(tokens[exIndex + 1]) : null;
  trackedKeys.set(key, {
    key,
    lastCommand: `${source}: ${line}`,
    updatedAt: Date.now(),
    expiresAt: Number.isFinite(ttlSeconds) ? Date.now() + ttlSeconds * 1000 : null
  });
}

async function hydrateKnownKeys() {
  const files = [
    { file: path.join(repoRoot, "snapshot.rdb"), type: "snapshot" },
    { file: path.join(repoRoot, "data.log"), type: "wal" },
    { file: path.join(repoRoot, "MiniRedis", "snapshot.rdb"), type: "snapshot" },
    { file: path.join(repoRoot, "MiniRedis", "data.log"), type: "wal" }
  ];

  for (const entry of files) {
    try {
      const data = await fs.readFile(entry.file, "utf8");
      for (const line of data.split(/\r?\n/)) {
        const clean = line.trim();
        if (!clean) continue;

        if (entry.type === "snapshot") {
          rememberSnapshotLine(clean, "snapshot");
          continue;
        }

        const tokens = tokenize(clean);
        const op = tokens[0]?.toUpperCase();
        if (op === "SET" || op === "DEL" || op === "INCR" || op === "DECR") {
          rememberCommand(clean);
        }
      }
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(body)
  });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendTcpCommand(command) {
  const cleanCommand = normalizeCommand(command);

  return new Promise((resolve) => {
    const startedAt = performance.now();
    const socket = net.createConnection({ host: REDIS_HOST, port: REDIS_PORT });
    let buffer = "";
    let complete = false;

    const finish = (result) => {
      if (complete) return;
      complete = true;
      socket.destroy();
      resolve({
        latencyMs: Math.round(performance.now() - startedAt),
        ...result
      });
    };

    socket.setTimeout(TCP_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write("CLIENT\n");
      socket.write(`${cleanCommand}\n`);
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      if (buffer.includes("Server busy\n")) {
        finish({ ok: false, response: "Server busy", error: "Mini Redis refused the connection because it is at capacity." });
        return;
      }

      const newlineIndex = buffer.indexOf("\n");
      if (newlineIndex >= 0) {
        const response = buffer.slice(0, newlineIndex);
        if (isLikelyWrite(tokenize(cleanCommand))) rememberCommand(cleanCommand);
        finish({ ok: true, response });
      }
    });

    socket.on("timeout", () => {
      finish({ ok: false, response: "", error: `Timed out after ${TCP_TIMEOUT_MS}ms.` });
    });

    socket.on("error", (error) => {
      finish({ ok: false, response: "", error: error.message });
    });

    socket.on("close", () => {
      if (!complete && buffer.trim()) {
        finish({ ok: true, response: buffer.trim() });
      } else if (!complete) {
        finish({ ok: false, response: "", error: "Connection closed before a response was received." });
      }
    });
  });
}

function sendTcpBatch(commands) {
  const cleanCommands = commands.map(normalizeCommand).filter(Boolean);

  return new Promise((resolve) => {
    if (cleanCommands.length === 0) {
      resolve([]);
      return;
    }

    const socket = net.createConnection({ host: REDIS_HOST, port: REDIS_PORT });
    const results = [];
    let buffer = "";
    let activeCommand = null;
    let activeStartedAt = 0;
    let index = 0;
    let complete = false;

    const finish = (remainingResult) => {
      if (complete) return;
      complete = true;
      if (remainingResult) {
        while (results.length < cleanCommands.length) {
          results.push(remainingResult);
        }
      }
      socket.destroy();
      resolve(results);
    };

    const sendNext = () => {
      if (index >= cleanCommands.length) {
        finish();
        return;
      }

      activeCommand = cleanCommands[index++];
      activeStartedAt = performance.now();
      socket.write(`${activeCommand}\n`);
    };

    socket.setTimeout(TCP_TIMEOUT_MS);

    socket.on("connect", () => {
      socket.write("CLIENT\n");
      sendNext();
    });

    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");

      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const response = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);

        if (response === "Server busy") {
          finish({
            ok: false,
            response,
            error: "Mini Redis refused the connection because it is at capacity.",
            latencyMs: Math.round(performance.now() - activeStartedAt)
          });
          return;
        }

        if (isLikelyWrite(tokenize(activeCommand))) rememberCommand(activeCommand);
        results.push({
          ok: true,
          response,
          latencyMs: Math.round(performance.now() - activeStartedAt)
        });
        sendNext();
      }
    });

    socket.on("timeout", () => {
      finish({ ok: false, response: "", error: `Timed out after ${TCP_TIMEOUT_MS}ms.`, latencyMs: TCP_TIMEOUT_MS });
    });

    socket.on("error", (error) => {
      finish({ ok: false, response: "", error: error.message, latencyMs: 0 });
    });

    socket.on("close", () => {
      if (!complete) {
        finish({ ok: false, response: "", error: "Connection closed before all responses were received.", latencyMs: 0 });
      }
    });
  });
}

class MiniRedisSession {
  constructor(id) {
    this.id = id;
    this.socket = null;
    this.buffer = "";
    this.queue = [];
    this.connected = false;
    this.closed = false;
    this.createdAt = Date.now();
    this.lastCommand = "";
    this.lastResponse = "";
    this.lastLatencyMs = null;
    this.commandCount = 0;
    this.inFlight = 0;
  }

  connect() {
    return new Promise((resolve) => {
      const startedAt = performance.now();
      this.socket = net.createConnection({ host: REDIS_HOST, port: REDIS_PORT });

      const finish = (result) => {
        resolve({
          latencyMs: Math.round(performance.now() - startedAt),
          ...result
        });
      };

      this.socket.on("connect", () => {
        this.connected = true;
        this.socket.write("CLIENT\n");
        finish({ ok: true });
      });

      this.socket.on("data", (chunk) => {
        this.buffer += chunk.toString("utf8");
        this.drainResponses();
      });

      this.socket.on("error", (error) => {
        this.connected = false;
        this.rejectPending(error.message);
        finish({ ok: false, error: error.message });
      });

      this.socket.on("close", () => {
        this.connected = false;
        this.closed = true;
        sessions.delete(this.id);
        this.rejectPending("Mini Redis closed the TCP connection.");
        broadcastSessions();
      });
    });
  }

  drainResponses() {
    let newlineIndex;
    while ((newlineIndex = this.buffer.indexOf("\n")) >= 0) {
      const response = this.buffer.slice(0, newlineIndex);
      this.buffer = this.buffer.slice(newlineIndex + 1);
      const pending = this.queue.shift();
      if (!pending) continue;

      clearTimeout(pending.timer);
      this.inFlight = Math.max(0, this.inFlight - 1);

      if (response === "Server busy") {
        this.lastResponse = response;
        this.lastLatencyMs = Math.round(performance.now() - pending.startedAt);
        broadcastSessions();
        pending.resolve({
          ok: false,
          response,
          error: "Mini Redis refused the connection because it is at capacity.",
          latencyMs: Math.round(performance.now() - pending.startedAt)
        });
        this.close();
        continue;
      }

      if (isLikelyWrite(tokenize(pending.command))) rememberCommand(pending.command);
      this.commandCount++;
      this.lastResponse = response;
      this.lastLatencyMs = Math.round(performance.now() - pending.startedAt);
      broadcastSessions();
      pending.resolve({
        ok: true,
        response,
        latencyMs: this.lastLatencyMs
      });
    }
  }

  command(command) {
    const cleanCommand = normalizeCommand(command);

    return new Promise((resolve) => {
      if (!cleanCommand) {
        resolve({ ok: false, response: "", error: "Command is required.", latencyMs: 0 });
        return;
      }

      if (!this.connected || this.closed || !this.socket) {
        resolve({ ok: false, response: "", error: "Mini Redis session is not connected.", latencyMs: 0 });
        return;
      }

      const pending = {
        command: cleanCommand,
        resolve,
        startedAt: performance.now(),
        timer: null
      };

      pending.timer = setTimeout(() => {
        const index = this.queue.indexOf(pending);
        if (index >= 0) this.queue.splice(index, 1);
        this.inFlight = Math.max(0, this.inFlight - 1);
        this.lastResponse = "TIMEOUT";
        this.lastLatencyMs = TCP_TIMEOUT_MS;
        broadcastSessions();
        resolve({
          ok: false,
          response: "",
          error: `Timed out after ${TCP_TIMEOUT_MS}ms.`,
          latencyMs: TCP_TIMEOUT_MS
        });
      }, TCP_TIMEOUT_MS);

      this.inFlight++;
      this.lastCommand = cleanCommand;
      broadcastSessions();
      this.queue.push(pending);
      this.socket.write(`${cleanCommand}\n`);
    });
  }

  async batch(commands) {
    const results = [];
    for (const command of commands) {
      results.push(await this.command(command));
    }
    return results;
  }

  rejectPending(error) {
    for (const pending of this.queue.splice(0)) {
      clearTimeout(pending.timer);
      this.inFlight = Math.max(0, this.inFlight - 1);
      this.lastResponse = "ERROR";
      pending.resolve({
        ok: false,
        response: "",
        error,
        latencyMs: Math.round(performance.now() - pending.startedAt)
      });
    }
  }

  close() {
    this.closed = true;
    this.connected = false;
    sessions.delete(this.id);
    this.socket?.destroy();
  }
}

async function getStatus() {
  const result = await sendTcpCommand("TTL __mini_redis_dashboard_probe__");
  return {
    connected: result.ok,
    latencyMs: result.ok ? result.latencyMs : null,
    backend: `${REDIS_HOST}:${REDIS_PORT}`,
    error: result.ok ? null : result.error
  };
}

async function getKeys() {
  await hydrateKnownKeys();
  const now = Date.now();
  const keys = [];

  for (const [key, meta] of trackedKeys) {
    if (meta.expiresAt && meta.expiresAt <= now) {
      trackedKeys.delete(key);
      continue;
    }

    const [exists, ttl, value] = await sendTcpBatch([
      `EXISTS ${key}`,
      `TTL ${key}`,
      `GET ${key}`
    ]);

    if (!exists.ok || exists.response !== "1") {
      trackedKeys.delete(key);
      continue;
    }

    keys.push({
      key,
      value: value.ok ? value.response : "",
      ttl: ttl.ok ? Number(ttl.response) : null,
      updatedAt: meta.updatedAt,
      lastCommand: meta.lastCommand
    });
  }

  keys.sort((a, b) => a.key.localeCompare(b.key));
  return keys;
}

async function getKeysForSession(session) {
  await hydrateKnownKeys();
  const now = Date.now();
  const keys = [];

  for (const [key, meta] of trackedKeys) {
    if (meta.expiresAt && meta.expiresAt <= now) {
      trackedKeys.delete(key);
      continue;
    }

    const [exists, ttl, value] = await session.batch([
      `EXISTS ${key}`,
      `TTL ${key}`,
      `GET ${key}`
    ]);

    if (!exists.ok || exists.response !== "1") {
      trackedKeys.delete(key);
      continue;
    }

    keys.push({
      key,
      value: value.ok ? value.response : "",
      ttl: ttl.ok ? Number(ttl.response) : null,
      updatedAt: meta.updatedAt,
      lastCommand: meta.lastCommand
    });
  }

  keys.sort((a, b) => a.key.localeCompare(b.key));
  return keys;
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url, `http://${req.headers.host}`);
  const pathname = decodeURIComponent(requestUrl.pathname);
  const safePath = pathname === "/" ? "/index.html" : pathname;
  const filePath = path.normalize(path.join(publicDir, safePath));

  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await fs.readFile(filePath);
    const ext = path.extname(filePath);
    res.writeHead(200, {
      "content-type": contentTypes.get(ext) || "application/octet-stream"
    });
    res.end(file);
  } catch {
    res.writeHead(404);
    res.end("Not found");
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (req.method === "GET" && url.pathname === "/api/status") {
      sendJson(res, 200, await getStatus());
      return;
    }

    if (req.method === "GET" && url.pathname === "/api/keys") {
      sendJson(res, 200, { keys: await getKeys() });
      return;
    }

    if (req.method === "POST" && url.pathname === "/api/command") {
      const body = await readJson(req);
      const command = normalizeCommand(body.command);

      if (!command) {
        sendJson(res, 400, { ok: false, error: "Command is required." });
        return;
      }

      sendJson(res, 200, await sendTcpCommand(command));
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    res.writeHead(405);
    res.end("Method not allowed");
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
});

function encodeWsFrame(payload) {
  const data = Buffer.from(JSON.stringify(payload));
  const length = data.length;

  if (length < 126) {
    return Buffer.concat([Buffer.from([0x81, length]), data]);
  }

  if (length < 65536) {
    const header = Buffer.alloc(4);
    header[0] = 0x81;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, data]);
  }

  const header = Buffer.alloc(10);
  header[0] = 0x81;
  header[1] = 127;
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, data]);
}

function decodeWsFrames(buffer) {
  const frames = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;
    let headerLength = 2;

    if (length === 126) {
      if (offset + 4 > buffer.length) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (offset + 10 > buffer.length) break;
      length = Number(buffer.readBigUInt64BE(offset + 2));
      headerLength = 10;
    }

    const maskLength = masked ? 4 : 0;
    const frameEnd = offset + headerLength + maskLength + length;
    if (frameEnd > buffer.length) break;

    let payload = buffer.subarray(offset + headerLength + maskLength, frameEnd);
    if (masked) {
      const mask = buffer.subarray(offset + headerLength, offset + headerLength + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    frames.push({ opcode, text: payload.toString("utf8") });
    offset = frameEnd;
  }

  return { frames, remaining: buffer.subarray(offset) };
}

function sendWs(socket, payload) {
  socket.write(encodeWsFrame(payload));
}

function sessionPayload() {
  return [...sessions.values()].map((session) => ({
    id: session.id,
    connected: session.connected,
    createdAt: session.createdAt,
    commandCount: session.commandCount,
    inFlight: session.inFlight,
    lastCommand: session.lastCommand,
    lastResponse: session.lastResponse,
    lastLatencyMs: session.lastLatencyMs
  }));
}

function broadcastSessions() {
  const payload = {
    type: "sessions",
    sessions: sessionPayload()
  };

  for (const session of sessions.values()) {
    if (session.wsSocket?.writable) sendWs(session.wsSocket, payload);
  }
}

function broadcastActivity() {
  const payload = {
    type: "activity",
    activity: activityLog
  };

  for (const session of sessions.values()) {
    if (session.wsSocket?.writable) sendWs(session.wsSocket, payload);
  }
}

function recordActivity(entry) {
  activityLog.unshift({
    id: crypto.randomUUID().slice(0, 8),
    at: Date.now(),
    ...entry
  });

  if (activityLog.length > MAX_ACTIVITY) activityLog.length = MAX_ACTIVITY;
  broadcastActivity();
}

server.on("upgrade", (req, socket) => {
  if (req.url !== "/ws") {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  if (!key) {
    socket.destroy();
    return;
  }

  const accept = crypto
    .createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    ""
  ].join("\r\n"));

  const sessionId = crypto.randomUUID().slice(0, 8);
  const session = new MiniRedisSession(sessionId);
  session.wsSocket = socket;
  sessions.set(sessionId, session);

  sendWs(socket, {
    type: "system",
    message: `Opening persistent Mini Redis TCP session ${sessionId} -> ${REDIS_HOST}:${REDIS_PORT}`
  });

  session.connect().then((result) => {
    sendWs(socket, {
      type: "status",
      connected: result.ok,
      sessionId,
      latencyMs: result.ok ? result.latencyMs : null,
      backend: `${REDIS_HOST}:${REDIS_PORT}`,
      error: result.ok ? null : result.error
    });

    if (result.ok) {
      sendWs(socket, {
        type: "system",
        message: `Mini Redis TCP session ${sessionId} is connected and will stay open while this tab is open.`
      });
    }

    sendWs(socket, { type: "sessions", sessions: sessionPayload() });
    sendWs(socket, { type: "activity", activity: activityLog });
    broadcastSessions();
  });

  let pending = Buffer.alloc(0);
  socket.on("data", async (chunk) => {
    pending = Buffer.concat([pending, chunk]);
    const decoded = decodeWsFrames(pending);
    pending = decoded.remaining;

    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        socket.end();
        return;
      }

      if (frame.opcode !== 0x1) continue;

      try {
        const message = JSON.parse(frame.text);
        if (message.type === "status") {
          sendWs(socket, {
            type: "status",
            connected: session.connected,
            sessionId,
            latencyMs: null,
            backend: `${REDIS_HOST}:${REDIS_PORT}`,
            error: session.connected ? null : "Mini Redis session is not connected."
          });
          continue;
        }

        if (message.type === "keys") {
          if (!session.connected) {
            sendWs(socket, { type: "keys", keys: [], error: "Mini Redis session is not connected." });
            continue;
          }

          sendWs(socket, { type: "keys", keys: await getKeysForSession(session) });
          continue;
        }

        const command = normalizeCommand(message.command);
        if (!command) continue;

        sendWs(socket, { type: "command", command, at: Date.now() });
        const result = await session.command(command);
        sendWs(socket, { type: "response", command, ...result, at: Date.now() });
        recordActivity({
          sessionId,
          command,
          ok: result.ok,
          response: result.ok ? result.response : result.error,
          latencyMs: result.latencyMs,
          op: tokenize(command)[0]?.toUpperCase() || "COMMAND",
          mutating: isLikelyWrite(tokenize(command))
        });
      } catch (error) {
        sendWs(socket, { type: "error", error: error.message });
      }
    }
  });

  socket.on("close", () => {
    session.close();
    broadcastSessions();
  });

  socket.on("error", () => {
    session.close();
    broadcastSessions();
  });
});

server.on("error", (error) => {
  console.error(`Dashboard server failed: ${error.message}`);
  process.exitCode = 1;
});

process.on("SIGTERM", () => {
  stopBundledMiniRedis();
  server.close(() => process.exit(0));
});

process.on("SIGINT", () => {
  stopBundledMiniRedis();
  server.close(() => process.exit(0));
});

startBundledMiniRedis();

server.listen(DASHBOARD_PORT, DASHBOARD_HOST, async () => {
  await hydrateKnownKeys();
  console.log(`Mini Redis dashboard listening on ${DASHBOARD_HOST}:${DASHBOARD_PORT}`);
  console.log(`Bridge target: ${REDIS_HOST}:${REDIS_PORT}`);
  if (AUTOSTART_BACKEND) {
    console.log("Bundled Mini Redis backend autostart is enabled");
  }
});
