import { createServer } from "node:http";
import type { IncomingMessage } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { WebSocket, WebSocketServer } from "ws";
import { PROTOCOL_VERSION, type ErrorMessage, type Hello } from "@hm/protocol";
import { logger } from "./log.js";
import { normalizeRoom, parseHello, RoomManager, type Peer } from "./rooms.js";
import { createStaticHandler } from "./static.js";

const HERE = dirname(fileURLToPath(import.meta.url));

const PORT = Number(process.env.PORT ?? 8080);
const HOST = process.env.HOST ?? "0.0.0.0";
const PUBLIC_DIR = resolve(process.env.PUBLIC_DIR ?? resolve(HERE, "../../ghost-app/dist"));
const RELAY_TOKEN = process.env.RELAY_TOKEN?.trim() || "";
const ROOM_TTL_MINUTES = Number(process.env.ROOM_TTL_MINUTES ?? 15);
const MAX_PAYLOAD = 2 * 1024 * 1024;
const HANDSHAKE_TIMEOUT_MS = 10_000;

const rooms = new RoomManager(ROOM_TTL_MINUTES);
const staticHandler = createStaticHandler(PUBLIC_DIR);

function json(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "access-control-allow-origin": "*",
  });
  res.end(payload);
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/health") {
    json(res, 200, {
      ok: true,
      protocol: PROTOCOL_VERSION,
      rooms: rooms.rooms.size,
      peers: [...rooms.rooms.values()].reduce((sum, room) => sum + room.peers.size, 0),
      uptime: Math.round(process.uptime()),
    });
    return;
  }

  if (url.pathname.startsWith("/api/rooms/")) {
    const raw = url.pathname.slice("/api/rooms/".length);
    const code = normalizeRoom(raw);
    if (!code) {
      json(res, 400, { ok: false, error: "bad_room" });
      return;
    }
    const summary = rooms.summary(code);
    if (!summary) {
      json(res, 404, { ok: false, error: "not_found", room: code });
      return;
    }
    json(res, 200, { ok: true, ...summary });
    return;
  }

  staticHandler(req, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_PAYLOAD, perMessageDeflate: false });

type AliveSocket = WebSocket & { isAlive?: boolean };

server.on("upgrade", (req: IncomingMessage, socket, head) => {
  let pathname = "/";
  try {
    pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\n\r\n");
    socket.destroy();
    return;
  }

  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

function sendError(ws: WebSocket, code: string, message: string): void {
  const payload: ErrorMessage = { t: "error", code, message };
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(payload));
  }
}

wss.on("connection", (ws: AliveSocket) => {
  ws.isAlive = true;
  ws.on("pong", () => {
    ws.isAlive = true;
  });

  let peer: Peer | null = null;
  let handshakeTimer: NodeJS.Timeout | null = setTimeout(() => {
    if (!peer) {
      sendError(ws, "handshake_timeout", "Не получен hello за 10 секунд.");
      ws.close(4000, "handshake timeout");
    }
  }, HANDSHAKE_TIMEOUT_MS);

  ws.on("message", (raw) => {
    if (!peer) {
      const hello = parseHello(raw);
      if (!hello) {
        sendError(ws, "bad_hello", "Первое сообщение должно быть hello.");
        ws.close(4000, "bad hello");
        return;
      }

      if (hello.protocol !== PROTOCOL_VERSION) {
        sendError(
          ws,
          "protocol_mismatch",
          `Версия протокола ${hello.protocol} не поддерживается (нужна ${PROTOCOL_VERSION}).`,
        );
        ws.close(4001, "protocol mismatch");
        return;
      }

      const roomCode = normalizeRoom(hello.room);
      if (!roomCode) {
        sendError(ws, "bad_room", "Код комнаты: 4-8 символов A-Z и 0-9.");
        ws.close(4002, "bad room");
        return;
      }

      if (hello.role === "game" && RELAY_TOKEN && hello.token !== RELAY_TOKEN) {
        sendError(ws, "bad_token", "Неверный токен relay.");
        ws.close(4003, "bad token");
        return;
      }

      const result = rooms.join({
        ws,
        role: hello.role,
        room: roomCode,
        name: hello.name,
      });

      if (!result.ok) {
        sendError(ws, result.code, result.message);
        ws.close(4004, result.code);
        return;
      }

      peer = result.peer;
      if (handshakeTimer) {
        clearTimeout(handshakeTimer);
        handshakeTimer = null;
      }

      const { room } = result;
      room.send(peer, room.welcome(peer));
      room.sendCache(peer);
      room.broadcast(room.peerJoined(peer), peer.id);

      logger.info(
        "ws",
        `${peer.role} ${peer.name ? `"${peer.name}" ` : ""}joined room ${room.code} as ${peer.id} (${room.peers.size} peer(s))`,
      );
      return;
    }

    peer.room.handleRaw(peer, raw);
  });

  ws.on("close", (code, reason) => {
    if (handshakeTimer) {
      clearTimeout(handshakeTimer);
      handshakeTimer = null;
    }
    if (!peer) return;

    const room = peer.room;
    rooms.leave(peer);
    logger.info(
      "ws",
      `${peer.role} ${peer.id} left room ${room.code} (${code}${reason.length ? ` ${reason.toString()}` : ""}); ${room.peers.size} left`,
    );
    peer = null;
  });

  ws.on("error", (error) => {
    logger.warn("ws", `socket error: ${String(error)}`);
  });
});

const heartbeat = setInterval(() => {
  for (const ws of wss.clients as Set<AliveSocket>) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    try {
      ws.ping();
    } catch {
      // ignore
    }
  }
}, 30_000);

const sweeper = setInterval(() => {
  const removed = rooms.sweep();
  if (removed > 0) logger.debug("room", `swept ${removed} empty room(s)`);
}, 60_000);

server.listen(PORT, HOST, () => {
  logger.info("relay", `listening on http://${HOST}:${PORT}`);
  logger.info("relay", `ghost client dir: ${PUBLIC_DIR}`);
  logger.info("relay", `ws endpoint: ws://${HOST}:${PORT}/ws`);
  if (RELAY_TOKEN) logger.info("relay", "game connections require RELAY_TOKEN");
});

let shuttingDown = false;
function shutdown(signal: string): void {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info("relay", `${signal} received, shutting down`);
  clearInterval(heartbeat);
  clearInterval(sweeper);
  rooms.closeAll();
  wss.close();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
