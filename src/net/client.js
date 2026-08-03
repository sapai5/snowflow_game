/**
 * The client half of the network.
 *
 * Owns the socket and the translation in both directions:
 *
 *   out   the local player's movement at 20 Hz, plus a claim for every hit, clash and
 *         cast the local resolver produced this frame. The resolver already publishes
 *         those as events for the HUD and the impact effects, so the network is a third
 *         reader of a list that had to exist anyway rather than a new code path through
 *         combat.
 *
 *   in    snapshots into `RemoteDriver`, and the authority's rulings — health, death,
 *         respawn, cooldowns, effects — straight onto the players they concern.
 *
 * Join and leave create and destroy real `Player` objects, so a remote player is the
 * same class as the local one with its position coming from a different place. That was
 * the point of building the intent seam before any of this existed.
 *
 * Disconnects are survivable: the world keeps running with whoever is left, and a lost
 * socket retries with a backoff rather than ending the session. A dropped tunnel is the
 * most likely failure in this whole design and it should not cost anyone their game.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import {
    msg, decode, encode, SNAPSHOT_HZ,
    WELCOME, SNAPSHOT, HEALTH, DIED, SPAWNED, CAST_RELAY, EFFECT, COOLDOWNS,
    JOINED, LEFT, CLASH, REJECTED, PONG, encodeState,
} from "./protocol.js";
import { RemoteDriver } from "./remote.js";
import { SPELL_COOLDOWN } from "../game/rules.js";

/** Reconnect backoff, seconds. Capped so a long outage still retries eventually. */
const RETRY_MIN = 1;
const RETRY_MAX = 15;

export class NetClient {
    /**
     * @param {import("../game/world.js").World} world
     * @param {{ url?: string, room: string, name: string,
     *           onStatus?: (s: string, detail?: any) => void,
     *           onEvent?: (kind: string, data: any) => void }} opts
     */
    constructor(world, opts) {
        this.world = world;
        this.room = opts.room;
        this.name = opts.name;
        this.url = opts.url || defaultUrl();
        this.onStatus = opts.onStatus || (() => {});
        this.onEvent = opts.onEvent || (() => {});

        this.driver = new RemoteDriver();
        /** @type {WebSocket|null} */
        this.ws = null;
        this.localId = null;
        this.seed = null;
        this.connected = false;
        this.rejected = null;

        /** Round-trip time, seconds. Reported for the overlay; nothing depends on it. */
        this.rtt = 0;

        this._sinceState = 0;
        this._sincePing = 0;
        this._retry = RETRY_MIN;
        this._retryIn = 0;
        this._closed = false;

        /** Names by id, for the scoreboard and the kill feed. */
        this.names = new Map();
        /** @type {Array<{id: string, name: string, kills: number, deaths: number}>} */
        this.scores = [];
    }

    /** True once the authority has told us who we are. */
    get ready() {
        return this.connected && this.localId !== null;
    }

    connect() {
        this._closed = false;
        this.onStatus("connecting");
        let ws;
        try {
            ws = new WebSocket(this.url + "?room=" + encodeURIComponent(this.room));
        } catch (err) {
            this._scheduleRetry();
            return;
        }
        this.ws = ws;

        ws.onopen = () => {
            this.connected = true;
            this._retry = RETRY_MIN;
            ws.send(encode(msg.join(this.room, this.name)));
        };
        ws.onmessage = (ev) => {
            const m = decode(typeof ev.data === "string" ? ev.data : "");
            if (m) this._receive(m);
        };
        ws.onclose = () => {
            this.connected = false;
            this.ws = null;
            if (!this._closed) {
                this.onStatus("lost");
                this._scheduleRetry();
            }
        };
        ws.onerror = () => {
            // `onclose` always follows, so the retry is scheduled in one place.
        };
    }

    /** Stop for good. */
    close() {
        this._closed = true;
        if (this.ws) this.ws.close();
        this.ws = null;
        this.connected = false;
    }

    _scheduleRetry() {
        this._retryIn = this._retry;
        this._retry = Math.min(RETRY_MAX, this._retry * 2);
    }

    /**
     * Called once per frame, after the world has updated and before its events are
     * drained.
     *
     * @param {number} dt
     */
    update(dt) {
        if (this._retryIn > 0) {
            this._retryIn -= dt;
            if (this._retryIn <= 0) this.connect();
            return;
        }
        if (!this.ready) return;

        this.driver.tick(dt);
        this._sendClaims();

        // State at a fixed rate, independent of frame rate: a client running at 144 fps
        // has no business sending seven times as much as one running at 20.
        this._sinceState += dt;
        const interval = 1 / SNAPSHOT_HZ;
        if (this._sinceState >= interval) {
            this._sinceState = 0;
            const me = this.world.local;
            if (me) this._send(msg.state(encodeState(me)));
        }

        this._sincePing += dt;
        if (this._sincePing >= 2) {
            this._sincePing = 0;
            this._send(msg.ping(performance.now()));
        }
    }

    /**
     * Apply the interpolated snapshots.
     *
     * Called *before* the world updates rather than after, so a remote player's figure
     * is posed from the position it is meant to be at this frame. The other order works
     * and is one frame stale, which at four players in a fight is a visible lag on
     * everyone else's blade.
     *
     * @param {number} localTime
     */
    applyRemotes(localTime) {
        if (!this.ready) return;
        for (const p of this.world.players.values()) {
            if (!p.remote) continue;
            this.driver.apply(p, localTime);
        }
    }

    // --------------------------------------------------------------- outgoing

    /**
     * Turn this frame's local combat events into claims.
     *
     * Only events we caused: the resolver is already limited to our own blade and our
     * own volumes by `ownerId`, so anything in the list with our id on it is ours to
     * report. Filtering again here is belt and braces against a future caller that
     * raises an event on someone else's behalf.
     */
    _sendClaims() {
        const events = this.world.combat.events;
        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.by !== this.localId) continue;

            if (e.kind === "hit") {
                this._send(msg.hit(e.on, e.amount, "sword", e.stage, e.kb));
            } else if (e.kind === "spellHit") {
                this._send(msg.hit(e.on, e.amount, "spell", 0, e.kb));
                // A spell's status effect is a second claim off one event: the victim's
                // client never resolved the volume, so without this it would never learn
                // it had been slowed, blinded or pinned in the air.
                if (e.effect !== null && e.effect !== undefined && e.seconds > 0) {
                    this._send(msg.effectHit(e.on, e.effect, e.magnitude, e.seconds, e.spell));
                }
            } else if (e.kind === "burn") {
                this._send(msg.hit(e.on, e.amount, "burn", 0, null));
            } else if (e.kind === "clash") {
                this._send(msg.clash(e.on));
            } else if (e.kind === "cast") {
                this._send(msg.cast(e.spell, e.origin, e.aim));
            }
        }
    }

    _send(m) {
        if (this.ws && this.ws.readyState === 1) this.ws.send(encode(m));
    }

    // --------------------------------------------------------------- incoming

    _receive(m) {
        switch (m.t) {
            case WELCOME: return this._welcome(m);
            case SNAPSHOT: return this._snapshot(m);
            case JOINED: return this._joined(m);
            case LEFT: return this._left(m);
            case HEALTH: return this._health(m);
            case DIED: return this._died(m);
            case SPAWNED: return this._spawned(m);
            case CAST_RELAY: return this._cast(m);
            case EFFECT: return this._effect(m);
            case COOLDOWNS: return this._cooldowns(m);
            case CLASH: return this._clash(m);
            case PONG:
                this.rtt = Math.max(0, (performance.now() - m.c) / 1000);
                return;
            case REJECTED:
                this.rejected = m.why;
                this._closed = true;
                this.onStatus("rejected", m);
                return;
            default: return;
        }
    }

    _welcome(m) {
        this.localId = m.yourId;
        this.seed = m.seed;
        // Before anything else: every ruling that follows is stamped in server time, and
        // converting one with an unknown offset is worse than not converting it at all.
        this.driver.seedClock(m.now, this.world.now);
        // The local player already exists — the game is playable before the socket is —
        // so it is adopted rather than created. Its id changes to the authority's, which
        // is why the world keys players by id rather than by index.
        const me = this.world.local;
        if (me) this.world.rekey(me, m.yourId);
        for (const p of m.players || []) {
            this.names.set(p.id, p.name);
            if (p.id === m.yourId) continue;
            this._ensureRemote(p.id, p.name, p);
        }
        // From here the server owns health, and this client owns only its own hits.
        this.world.combat.authoritative = false;
        this.world.combat.ownerId = m.yourId;
        this.onStatus("joined", m);
    }

    _snapshot(m) {
        this.driver.accept(m.at, m.s || {}, this.world.now);
    }

    _joined(m) {
        if (m.id === this.localId) return;
        this.names.set(m.id, m.name);
        this._ensureRemote(m.id, m.name, null);
        this.onEvent("joined", m);
    }

    _left(m) {
        this.driver.forget(m.id);
        this.world.despawn(m.id);
        if (m.score) this.scores = m.score;
        this.onEvent("left", { id: m.id, name: this.names.get(m.id) || m.id });
        this.names.delete(m.id);
    }

    _health(m) {
        const p = this.world.players.get(m.id);
        if (!p) return;
        // Assigned, not subtracted. The server's number is the truth; applying a delta
        // to whatever this client happened to believe would let a dropped message
        // desync the bar permanently.
        p.health = m.hp;
        if (m.by && m.by !== m.id) p.flash = 1;
        // The shove, applied by the only client entitled to move this player. Ours is
        // the only one that will find itself here, because the authority sends the
        // impulse to everyone and everyone else ignores it.
        if (m.kb && p === this.world.local) {
            this.world.combat.applyImpulse(p, m.kb[0], m.kb[1], m.kb[2]);
        }
    }

    _died(m) {
        const p = this.world.players.get(m.id);
        if (m.score) this.scores = m.score;
        if (!p) return;
        this.world.combat.kill(p, m.by || null);
        // The authority's clock, converted to ours through the offset the driver already
        // maintains. A respawn countdown that disagrees between clients is a player
        // standing up on one screen and still face-down on another.
        const offset = this.driver.offset === null ? 0 : this.driver.offset;
        p.respawnAt = m.respawnAt - offset;
        this.onEvent("died", {
            id: m.id, by: m.by,
            name: this.names.get(m.id) || m.id,
            killer: m.by ? this.names.get(m.by) || m.by : null,
        });
    }

    _spawned(m) {
        const p = this.world.players.get(m.id);
        if (!p) return;
        p.health = m.hp;
        p.alive = true;
        p.effects.clearAll();
        // Only we move ourselves. A remote player's position is their client's business
        // and their next snapshot will say where they came back.
        if (p === this.world.local) this.world.respawnLocal(p);
    }

    _cast(m) {
        // Replayed through the same entry point the local player uses, so a remote cast
        // produces the identical volume and the identical picture. The authoritative
        // spell zones of the plan are authoritative for exactly this reason: everyone
        // builds them from this one message.
        this.onEvent("cast", m);
    }

    _effect(m) {
        const p = this.world.players.get(m.id);
        if (!p) return;
        const offset = this.driver.offset === null ? 0 : this.driver.offset;
        const seconds = Math.max(0, m.endsAt - offset - this.world.now);
        if (seconds > 0) p.effects.apply(m.e, m.m, seconds, m.by || null);
    }

    _cooldowns(m) {
        const me = this.world.local;
        if (!me || !Array.isArray(m.ready)) return;
        const offset = this.driver.offset === null ? 0 : this.driver.offset;
        for (let i = 0; i < me.cooldowns.length && i < m.ready.length; i++) {
            // A zero from the server means "never used", which is not the same as "ready
            // at time zero" once our clock has been running for a while — though both
            // read as ready. Converted the same way as everything else for consistency.
            me.cooldowns[i] = m.ready[i] > 0 ? m.ready[i] - offset : 0;
        }
    }

    _clash(m) {
        const a = this.world.players.get(m.by);
        const b = this.world.players.get(m.id);
        if (!a || !b) return;
        // Both sides stagger and both blades bounce, on every client, from the one
        // message. The client that detected it has already done this locally; doing it
        // again is idempotent because a stagger takes the longer of the two timers.
        this.world.combat.applyClash(a, b);
    }

    _ensureRemote(id, name, info) {
        if (this.world.players.has(id)) return this.world.players.get(id);
        const p = this.world.spawn({ id, name, isLocal: false });
        p.remote = true;
        if (info) {
            p.health = info.health ?? p.health;
            p.alive = info.alive ?? p.alive;
        }
        return p;
    }
}

/**
 * Where the relay is, absent an explicit setting.
 *
 * Same host as the page, upgraded to a socket scheme. That makes the shared link work
 * unchanged whether it points at a Cloudflare tunnel, a free-tier host, or localhost —
 * which is the entire point of serving the client from the relay.
 *
 * In development the page comes from Vite on another port, so the relay's own port is
 * assumed. There is no way to discover it and guessing right most of the time beats
 * requiring a query parameter nobody will remember.
 */
export function defaultUrl() {
    if (typeof location === "undefined") return "ws://localhost:8787";
    const scheme = location.protocol === "https:" ? "wss:" : "ws:";
    const devPort = location.port === "5173" || location.port === "5199";
    const host = devPort ? location.hostname + ":8787" : location.host;
    return scheme + "//" + host;
}

/** The room from the URL, or null for single player. */
export function roomFromUrl() {
    if (typeof location === "undefined") return null;
    const v = new URLSearchParams(location.search).get("room");
    return v ? v.toUpperCase() : null;
}

/** The link to hand someone. */
export function shareLink(room) {
    if (typeof location === "undefined") return "";
    const u = new URL(location.href);
    u.search = "?room=" + encodeURIComponent(room);
    u.hash = "";
    return u.toString();
}
