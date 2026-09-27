"use strict";

const assert = require("node:assert/strict");
const { once } = require("node:events");
const test = require("node:test");
const jwt = require("jsonwebtoken");
const { io: createClient } = require("socket.io-client");
const { createCallingServer } = require("./server");

const jwtSecret = "test-secret-that-is-long-enough-for-this-test";

function connect(url, subject, displayName = subject) {
  const token = jwt.sign({ displayName }, jwtSecret, { subject, algorithm: "HS256" });
  const socket = createClient(url, {
    auth: { token },
    transports: ["websocket"],
    reconnection: false,
  });
  return once(socket, "connect").then(() => socket);
}

function request(socket, event, payload = {}) {
  return new Promise((resolve) => socket.emit(event, payload, resolve));
}

test("authenticated peers can create, join, signal, mute, and end a room", async (context) => {
  const { httpServer, io } = createCallingServer({
    port: 0,
    jwtSecret,
    jwtIssuer: undefined,
    corsOrigins: ["*"],
    maxParticipants: 2,
    stunUrls: ["stun:test.example:3478"],
    turnUrls: [],
    turnSharedSecret: "",
    turnCredentialTtl: 3600,
  });
  httpServer.listen(0, "127.0.0.1");
  await once(httpServer, "listening");
  context.after(async () => {
    await new Promise((resolve) => io.close(resolve));
  });

  const url = `http://127.0.0.1:${httpServer.address().port}`;
  const owner = await connect(url, "user-owner", "Owner");
  const guest = await connect(url, "user-guest", "Guest");
  context.after(() => {
    owner.disconnect();
    guest.disconnect();
  });

  const created = await request(owner, "room:create");
  assert.equal(created.ok, true);
  assert.equal(created.data.iceServers[0].urls, "stun:test.example:3478");

  const joinedEvent = once(owner, "room:peer-joined");
  const joined = await request(guest, "room:join", { roomId: created.data.roomId });
  assert.equal(joined.ok, true);
  assert.equal(joined.data.peers.length, 1);
  assert.equal((await joinedEvent)[0].displayName, "Guest");

  const offerEvent = once(guest, "call:offer");
  const offer = { type: "offer", sdp: "v=0" };
  assert.equal((await request(owner, "call:offer", { targetPeerId: guest.id, sdp: offer })).ok, true);
  assert.deepEqual((await offerEvent)[0], { fromPeerId: owner.id, sdp: offer });

  const muteEvent = once(owner, "room:peer-muted");
  assert.equal((await request(guest, "call:mute", { muted: true })).ok, true);
  assert.deepEqual((await muteEvent)[0], { peerId: guest.id, muted: true });

  const endedEvent = once(guest, "room:ended");
  assert.equal((await request(owner, "room:end")).ok, true);
  assert.equal((await endedEvent)[0].roomId, created.data.roomId);
  assert.equal((await request(guest, "room:join", { roomId: created.data.roomId })).error, "Room not found.");
});