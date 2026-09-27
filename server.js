"use strict";

require("dotenv").config();

const { createHmac, randomUUID } = require("node:crypto");
const http = require("node:http");
const jwt = require("jsonwebtoken");
const { Server } = require("socket.io");

const DEFAULT_STUN_URLS = ["stun:stun.l.google.com:19302"];

function loadConfig(env = process.env) {
  const config = {
    port: Number(env.PORT || 3000),
    nodeEnv: env.NODE_ENV || "development",
    jwtSecret: env.JWT_SECRET || "",
    jwtIssuer: env.JWT_ISSUER || undefined,
    corsOrigins: parseList(env.CORS_ORIGINS, "*"),
    maxParticipants: Number(env.MAX_PARTICIPANTS || 8),
    stunUrls: parseList(env.STUN_URLS, DEFAULT_STUN_URLS.join(",")),
    turnUrls: parseList(env.TURN_URLS),
    turnSharedSecret: env.TURN_SHARED_SECRET || "",
    turnCredentialTtl: Number(env.TURN_CREDENTIAL_TTL_SECONDS || 3600),
  };

  if (!Number.isInteger(config.port) || config.port < 0 || config.port > 65535) {
    throw new Error("PORT must be an integer from 0 to 65535.");
  }
  if (!config.jwtSecret) {
    throw new Error("JWT_SECRET is required.");
  }
  if (!Number.isInteger(config.maxParticipants) || config.maxParticipants < 2 || config.maxParticipants > 32) {
    throw new Error("MAX_PARTICIPANTS must be an integer from 2 to 32.");
  }
  if (!Number.isInteger(config.turnCredentialTtl) || config.turnCredentialTtl < 60) {
    throw new Error("TURN_CREDENTIAL_TTL_SECONDS must be an integer of at least 60.");
  }
  if (config.nodeEnv === "production") {
    if (config.jwtSecret.length < 32) {
      throw new Error("JWT_SECRET must be at least 32 characters in production.");
    }
    if (config.corsOrigins.length === 0 || config.corsOrigins.includes("*")) {
      throw new Error("Set explicit CORS_ORIGINS in production; wildcard origins are not allowed.");
    }
  }

  return config;
}

function parseList(value, fallback = "") {
  return (value || fallback).split(",").map((item) => item.trim()).filter(Boolean);
}

function createIceServers(config, userId, nowSeconds = Math.floor(Date.now() / 1000)) {
  const servers = config.stunUrls.map((urls) => ({ urls }));
  if (config.turnSharedSecret && config.turnUrls.length > 0) {
    // Coturn validates this expiring username and password using the shared secret.
    const username = `${nowSeconds + config.turnCredentialTtl}:${userId}`;
    const credential = createHmac("sha1", config.turnSharedSecret).update(username).digest("base64");
    servers.push({ urls: config.turnUrls, username, credential });
  }
  return servers;
}

function createPeer(socket) {
  return {
    socketId: socket.id,
    userId: socket.data.userId,
    displayName: socket.data.displayName,
    muted: false,
  };
}

function peerSummary(peer) {
  return { peerId: peer.socketId, displayName: peer.displayName, muted: peer.muted };
}

async function leaveRoom(socket, rooms, notifyPeers = true) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room) {
    socket.data.roomId = undefined;
    return;
  }

  room.peers.delete(socket.id);
  socket.data.roomId = undefined;
  await socket.leave(roomId);
  if (notifyPeers) {
    socket.to(roomId).emit("room:peer-left", { peerId: socket.id });
  }
  if (room.ownerPeerId === socket.id) {
    // Promote a remaining participant so the room can still be ended.
    room.ownerPeerId = room.peers.keys().next().value;
  }
  if (room.peers.size === 0) {
    rooms.delete(roomId);
  }
}

function activeRoom(socket, rooms) {
  const roomId = socket.data.roomId;
  const room = rooms.get(roomId);
  if (!room || !room.peers.has(socket.id)) {
    throw new Error("Join a room before sending this event.");
  }
  return { roomId, room };
}

function register(socket, event, handler) {
  socket.on(event, async (payload, acknowledge) => {
    const reply = typeof acknowledge === "function" ? acknowledge : () => {};
    try {
      reply({ ok: true, data: await handler(payload) });
    } catch (error) {
      reply({ ok: false, error: error.message || "Request failed." });
    }
  });
}

function registerRoomHandlers(socket, { config, io, rooms }) {
  register(socket, "room:create", async () => {
    if (socket.data.roomId) {
      throw new Error("Leave your current room before creating another.");
    }
    const roomId = randomUUID();
    const peer = createPeer(socket);
    const room = { ownerPeerId: socket.id, peers: new Map([[socket.id, peer]]) };
    rooms.set(roomId, room);
    socket.data.roomId = roomId;
    await socket.join(roomId);
    return { roomId, peers: [], iceServers: createIceServers(config, peer.userId) };
  });

  register(socket, "room:join", async (payload) => {
    const roomId = payload?.roomId;
    if (typeof roomId !== "string" || roomId.length > 128) {
      throw new Error("A valid roomId is required.");
    }
    if (socket.data.roomId) {
      throw new Error("Leave your current room before joining another.");
    }
    const room = rooms.get(roomId);
    if (!room) {
      throw new Error("Room not found.");
    }
    if (room.peers.size >= config.maxParticipants) {
      throw new Error("Room is full.");
    }

    const peer = createPeer(socket);
    const existingPeers = [...room.peers.values()].map(peerSummary);
    room.peers.set(socket.id, peer);
    socket.data.roomId = roomId;
    await socket.join(roomId);
    socket.to(roomId).emit("room:peer-joined", peerSummary(peer));
    return { roomId, peers: existingPeers, iceServers: createIceServers(config, peer.userId) };
  });

  register(socket, "room:leave", async () => {
    await leaveRoom(socket, rooms);
    return {};
  });

  register(socket, "room:end", async () => {
    const { roomId, room } = activeRoom(socket, rooms);
    if (room.ownerPeerId !== socket.id) {
      throw new Error("Only the room owner can end the call.");
    }

    // Copy the IDs because leaving the room changes its membership map.
    for (const peerId of [...room.peers.keys()]) {
      const peerSocket = io.sockets.sockets.get(peerId);
      if (peerSocket) {
        peerSocket.emit("room:ended", { roomId, byPeerId: socket.id });
        await leaveRoom(peerSocket, rooms, false);
      }
    }
    return {};
  });
}

function registerCallHandlers(socket, { io, rooms }) {
  function relaySignal(event, payload, signal) {
    const { room } = activeRoom(socket, rooms);
    const targetPeerId = payload?.targetPeerId;
    if (typeof targetPeerId !== "string" || targetPeerId === socket.id) {
      throw new Error("A valid targetPeerId is required.");
    }
    const target = room.peers.get(targetPeerId);
    if (!target) {
      throw new Error("Target peer is not in this room.");
    }

    io.to(target.socketId).emit(event, { fromPeerId: socket.id, ...signal });
    return {};
  }

  function registerDescriptionRelay(event) {
    register(socket, event, (payload) => {
      const sdp = payload?.sdp;
      if (!sdp || typeof sdp !== "object" || typeof sdp.sdp !== "string") {
        throw new Error("A valid session description is required.");
      }
      return relaySignal(event, payload, { sdp });
    });
  }

  registerDescriptionRelay("call:offer");
  registerDescriptionRelay("call:answer");

  register(socket, "call:ice-candidate", (payload) => {
    const candidate = payload?.candidate;
    if (candidate !== null && (typeof candidate !== "object" || Array.isArray(candidate))) {
      throw new Error("A valid ICE candidate is required.");
    }
    return relaySignal("call:ice-candidate", payload, { candidate });
  });

  register(socket, "call:mute", (payload) => {
    const { roomId, room } = activeRoom(socket, rooms);
    if (typeof payload?.muted !== "boolean") {
      throw new Error("muted must be a boolean.");
    }

    // This broadcasts UI state; the client must also mute its local media track.
    room.peers.get(socket.id).muted = payload.muted;
    socket.to(roomId).emit("room:peer-muted", { peerId: socket.id, muted: payload.muted });
    return {};
  });
}

function registerSocketHandlers(socket, context) {
  registerRoomHandlers(socket, context);
  registerCallHandlers(socket, context);
  socket.on("disconnect", () => {
    void leaveRoom(socket, context.rooms);
  });
}

function createCallingServer(config) {
  const rooms = new Map();
  const httpServer = http.createServer((request, response) => {
    if (request.method === "GET" && request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ status: "ok" }));
      return;
    }
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "Not found" }));
  });
  const io = new Server(httpServer, {
    cors: { origin: config.corsOrigins.length === 1 ? config.corsOrigins[0] : config.corsOrigins },
    maxHttpBufferSize: 100_000,
  });

  io.use((socket, next) => {
    const token = socket.handshake.auth?.token;
    if (typeof token !== "string" || token.length === 0) {
      next(new Error("Authentication required."));
      return;
    }

    try {
      // Trust identity only after verifying a signed token from the app backend.
      const claims = jwt.verify(token, config.jwtSecret, {
        algorithms: ["HS256"],
        ...(config.jwtIssuer ? { issuer: config.jwtIssuer } : {}),
      });
      if (typeof claims !== "object" || typeof claims.sub !== "string" || !claims.sub.trim()) {
        throw new Error("Token must contain a subject.");
      }
      socket.data.userId = claims.sub.slice(0, 128);
      socket.data.displayName = String(claims.displayName || claims.name || claims.sub)
        .replace(/[\u0000-\u001f\u007f]/g, "")
        .trim()
        .slice(0, 64) || socket.data.userId;
      next();
    } catch {
      next(new Error("Invalid authentication token."));
    }
  });

  io.on("connection", (socket) => {
    registerSocketHandlers(socket, { config, io, rooms });
  });

  return { httpServer, io, rooms };
}

async function start() {
  const config = loadConfig();
  const { httpServer } = createCallingServer(config);
  await new Promise((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(config.port, "0.0.0.0", resolve);
  });
  console.log(`Calling signaling server listening on port ${config.port}`);
}

if (require.main === module) {
  start().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

module.exports = { createCallingServer, createIceServers, loadConfig };