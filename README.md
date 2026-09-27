# Calling Server

A single-instance WebRTC signaling server. It authenticates Socket.IO connections with HS256 JWTs, coordinates call rooms, relays offers/answers/ICE candidates, and can issue short-lived coturn credentials. Audio and video travel directly between clients or through TURN; this server does not record or forward media.

## Run locally

Use Node.js 20 or newer.

```powershell
Copy-Item .env.example .env
npm install
npm test
npm start
```

Set a strong `JWT_SECRET` in `.env`. The app's existing authentication service must issue an HS256 token with a `sub` claim and, optionally, `displayName` or `name`. If `JWT_ISSUER` is set, the token must also have the matching issuer. Pass the token when connecting:

```js
const socket = io("https://calls.example.com", {
  auth: { token: accessToken }
});
```

Do not add an unauthenticated token-issuing endpoint to this service; issue tokens from your trusted application backend.

## Socket events

Requests use Socket.IO acknowledgements and respond with `{ ok: true, data }` or `{ ok: false, error }`.

| Client event | Payload | Purpose |
| --- | --- | --- |
| `room:create` | none | Create a room and join as its owner; returns `roomId`, `peers`, and `iceServers`. |
| `room:join` | `{ roomId }` | Join an existing room; returns current peers and ICE servers. |
| `call:offer` | `{ targetPeerId, sdp }` | Relay a WebRTC offer to a peer in the same room. |
| `call:answer` | `{ targetPeerId, sdp }` | Relay a WebRTC answer. |
| `call:ice-candidate` | `{ targetPeerId, candidate }` | Relay an ICE candidate; `candidate: null` is allowed. |
| `call:mute` | `{ muted: boolean }` | Broadcast the participant's mute state. |
| `room:leave` | none | Leave the current room. |
| `room:end` | none | End the room; only its current owner may do this. |

Server notifications include `room:peer-joined`, `room:peer-left`, `room:peer-muted`, and `room:ended`. Peer IDs are Socket.IO connection IDs and should be treated as temporary. A room is held in memory and disappears when empty or when the server restarts.

## Deploy with Docker Compose

1. Copy `.env.example` to `.env` and set `JWT_SECRET` to a random value of at least 32 characters, `CORS_ORIGINS` to the exact app origins, `TURN_SHARED_SECRET` to a separate random value, and `TURN_EXTERNAL_IP` to the VPS public IPv4 address.
2. Set `TURN_URLS` to the public TURN hostname in `.env`; set `TURN_REALM` in `docker-compose.yml` to that hostname as well. Point the hostname's DNS to the VPS.
3. Allow inbound TCP/UDP 3478 and UDP 49160-49200 in the VPS firewall. Put the signaling service behind an HTTPS reverse proxy and forward WebSocket upgrades to port 3000.
4. Run `docker compose up --build -d`.

The Compose file starts both the signaling service and coturn. TURN is essential for clients on restrictive networks. Configure TLS at the reverse proxy; the example coturn service uses UDP/TCP TURN without TLS. For deployments requiring TURN over TLS, configure a certificate and `turns:` URL separately.

## Operational notes

`GET /healthz` is an unauthenticated liveness check. Rooms and membership are in process memory, so this setup is intended for one signaling instance. Multiple replicas require shared Socket.IO transport and coordinated room ownership/state. The service does not replace application authorization: decide who may create or join a room in your app before issuing or using its room ID.