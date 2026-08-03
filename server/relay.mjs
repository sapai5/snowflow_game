/**
 * The relay.
 *
 * A socket wrapper around `authority.mjs` and nothing else: accept connections, hand
 * frames to a room, send back whatever it returns. All the logic that could be wrong
 * lives next door where it can be tested without opening a port.
 *
 *   npm run relay                      # localhost:8787
 *   PORT=9000 npm run relay
 *
 * To let other people in, put a tunnel in front of it. Cloudflare's needs no account:
 *
 *   cloudflared tunnel --url http://localhost:8787
 *
 * That prints an `https://<something>.trycloudflare.com` URL, which *is* the shareable
 * link once the room code is appended:
 *
 *   https://<something>.trycloudflare.com/?room=SNOW-4KQ2
 *
 * The same process deploys unmodified anywhere that supports WebSockets — Fly, Render,
 * Deno Deploy all have free tiers — when the URL needs to stop changing.
 *
 * This also serves the built client, so one process and one link is the whole
 * deployment. In development Vite serves the game instead and this only has to answer
 * the socket, which is why a missing `dist/` is a log line rather than an error.
 */

import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { join, extname, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";

import { Lobby, ROOM_CAPACITY } from "./authority.mjs";
import { decode, encode, JOIN, WELCOME, REJECTED } from "../src/net/protocol.js";

const PORT = Number(process.env.PORT) || 8787;
const HERE = fileURLToPath(new URL(".", import.meta.url));
const DIST = join(HERE, "..", "dist");

/** The simulation step. 60 Hz so respawn timers land within a frame of correct. */
const TICK = 1 / 60;

const MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".json": "application/json",
    ".wgsl": "text/plain; charset=utf-8",
    ".png": "image/png",
    ".jpg": "image/jpeg",
    ".svg": "image/svg+xml",
    ".ico": "image/x-icon",
    ".woff2": "font/woff2",
};

const lobby = new Lobby();

/** Every live socket, and which room and player it belongs to. */
const conns = new Map();

const http = createServer(async (req, res) => {
    const url = new URL(req.url || "/", "http://localhost");

    if (url.pathname === "/health") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({
            ok: true,
            rooms: [...lobby.rooms.values()].map((r) => ({ code: r.code, players: r.peers.size })),
        }));
        return;
    }

    // Anything else is the game. Unknown paths fall back to index.html so a link with
    // a room code in it works as a bare URL.
    let path = normalize(url.pathname).replace(/^(\.\.[/\\])+/, "");
    if (path === "/" || path === "\\") path = "/index.html";
    let file = join(DIST, path);
    try {
        const s = await stat(file);
        if (s.isDirectory()) file = join(file, "index.html");
    } catch {
        file = join(DIST, "index.html");
    }
    try {
        const body = await readFile(file);
        res.writeHead(200, { "content-type": MIME[extname(file)] || "application/octet-stream" });
        res.end(body);
    } catch {
        res.writeHead(404, { "content-type": "text/plain" });
        res.end("no build yet — run `npm run build`, or use `npm run dev` for the client\n");
    }
});

const wss = new WebSocketServer({ server: http });

wss.on("connection", (ws, req) => {
    const url = new URL(req.url || "/", "http://localhost");
    // The room can come from the socket URL or from the join message. The URL form is
    // what a shared link produces.
    const fromUrl = url.searchParams.get("room");
    const conn = { ws, room: null, id: null };
    conns.set(ws, conn);

    ws.on("message", (raw) => {
        const m = decode(String(raw));
        if (!m) return;

        if (m.t === JOIN) {
            if (conn.id) return; // already in; a second join is a client bug
            const code = String(m.room || fromUrl || "").toUpperCase();
            const room = lobby.room(code);
            if (!room) {
                ws.send(encode({ t: REJECTED, why: "badRoom" }));
                return;
            }
            if (room.full) {
                ws.send(encode({ t: REJECTED, why: "full", capacity: ROOM_CAPACITY }));
                return;
            }
            const out = room.handle(null, m);
            // The id is whatever the welcome says it is, so there is one place that
            // decides and this is not it.
            const welcome = out.find((o) => o.m.t === WELCOME);
            if (!welcome) {
                ws.send(encode({ t: REJECTED, why: "rejected" }));
                return;
            }
            conn.room = room;
            conn.id = welcome.m.yourId;
            log(`${conn.id} joined ${room.code} (${room.peers.size}/${ROOM_CAPACITY})`);
            dispatch(room, out);
            return;
        }

        if (!conn.room || !conn.id) return;
        dispatch(conn.room, conn.room.handle(conn.id, m));
    });

    const bye = () => {
        conns.delete(ws);
        if (conn.room && conn.id) {
            const out = conn.room.drop(conn.id);
            log(`${conn.id} left ${conn.room.code}`);
            dispatch(conn.room, out);
        }
    };
    ws.on("close", bye);
    ws.on("error", bye);
});

/**
 * Send a batch.
 *
 * `to: null` means the whole room. Serialised once per distinct message rather than
 * once per recipient — at four players that saves nothing measurable, and it means the
 * broadcast path does not quietly become the expensive one if this ever holds more.
 */
function dispatch(room, out) {
    for (const item of out) {
        const raw = encode(item.m);
        if (item.to === null) {
            for (const conn of conns.values()) {
                if (conn.room === room && conn.ws.readyState === 1) conn.ws.send(raw);
            }
        } else {
            for (const conn of conns.values()) {
                if (conn.id === item.to && conn.ws.readyState === 1) conn.ws.send(raw);
            }
        }
    }
}

setInterval(() => {
    for (const item of lobby.tick(TICK)) dispatch(item.room, [item]);
}, TICK * 1000);

function log(s) {
    process.stdout.write(`[relay] ${s}\n`);
}

http.listen(PORT, () => {
    log(`listening on http://localhost:${PORT}`);
    log(`share:  http://localhost:${PORT}/?room=SNOW-TEST`);
    log("tunnel: cloudflared tunnel --url http://localhost:" + PORT);
});
