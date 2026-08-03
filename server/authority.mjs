/**
 * The authority.
 *
 * Deliberately not a simulator. With no anti-cheat required, clients own where they are
 * and what they hit; this owns the handful of facts that four independent clients cannot
 * be allowed to disagree about:
 *
 *   health          two clients can each believe they landed the killing blow. One
 *                   arbiter for "who is dead" costs almost nothing and removes a whole
 *                   class of confusion about who got the kill.
 *   death, respawn  a corpse has to be a corpse everywhere at once, or one client keeps
 *                   swinging at someone another client has already respawned.
 *   cooldowns       the one number a client has an obvious incentive to get wrong, and
 *                   the one that would be most annoying to be on the wrong end of.
 *   the seed        everyone has to be standing on the same mountain.
 *
 * Everything else is relayed untouched.
 *
 * No sockets in this file. It takes messages in and returns a list of things to send,
 * which is what makes the whole of Phase 4 testable in Node without opening a port —
 * and the reason the authority is where the interesting bugs get caught rather than
 * where they get discovered by four people in four browsers.
 */

import {
    MAX_HEALTH, RESPAWN_TIME, SPELL_COOLDOWN, MAX_CLAIM_DAMAGE, SPELLS, isSpellId,
} from "../src/game/rules.js";
import {
    PROTOCOL_VERSION, JOIN, STATE, HIT, CLASH, CAST, EFFECT_HIT, PING,
    WELCOME, SNAPSHOT, HEALTH, DIED, SPAWNED, CAST_RELAY, EFFECT, COOLDOWNS,
    JOINED, LEFT, PONG, REJECTED,
    validRoomCode,
} from "../src/net/protocol.js";

/** Hard cap per room. Four is the design; the fifth arrival is told so. */
export const ROOM_CAPACITY = 4;

/** How long a client can go silent before it is assumed gone, seconds. */
const TIMEOUT = 12;

/** One connected player, as the authority sees them. */
class Peer {
    constructor(id, name) {
        this.id = id;
        this.name = name;
        this.health = MAX_HEALTH;
        this.alive = true;
        this.deadAt = 0;
        this.respawnAt = 0;
        this.kills = 0;
        this.deaths = 0;
        this.lastHitBy = null;
        /** Server time each spell is ready, indexed 1..5. */
        this.ready = [0, 0, 0, 0, 0, 0];
        /** Newest movement state, relayed verbatim in snapshots. */
        this.state = null;
        this.lastSeen = 0;
    }

    scoreLine() {
        return { id: this.id, name: this.name, kills: this.kills, deaths: this.deaths };
    }
}

/**
 * One room: up to four players sharing a world.
 */
export class Room {
    /**
     * @param {string} code
     * @param {number} seed the terrain seed everybody generates from
     */
    constructor(code, seed) {
        this.code = code;
        this.seed = seed;
        /** @type {Map<string, Peer>} */
        this.peers = new Map();
        this.now = 0;
        this._nextId = 1;
        this._sinceSnapshot = 0;
    }

    get full() {
        return this.peers.size >= ROOM_CAPACITY;
    }

    /**
     * Take one message from one connection.
     *
     * @param {string|null} id the sender, or null if it has not joined yet
     * @param {object} m a decoded frame
     * @returns {Array<{ to: string|null, m: object }>} `to: null` means everyone
     */
    handle(id, m) {
        switch (m.t) {
            case JOIN: return this._join(m);
            case STATE: return this._state(id, m);
            case HIT: return this._hit(id, m);
            case CLASH: return this._clash(id, m);
            case CAST: return this._cast(id, m);
            case EFFECT_HIT: return this._effectHit(id, m);
            case PING: return [{ to: id, m: { t: PONG, c: m.c, s: this.now } }];
            default: return [];
        }
    }

    _join(m) {
        if (m.v !== PROTOCOL_VERSION) {
            // Version skew is the one rejection worth being explicit about: it happens
            // to whoever forgot to reload, and it is otherwise indistinguishable from
            // the game being broken.
            return [{ to: null, m: { t: REJECTED, why: "version", need: PROTOCOL_VERSION } }];
        }
        if (this.full) return [{ to: null, m: { t: REJECTED, why: "full" } }];

        const id = "p" + this._nextId++;
        const name = cleanName(m.name, id);
        const peer = new Peer(id, name);
        peer.lastSeen = this.now;
        this.peers.set(id, peer);

        const out = [{
            to: id,
            m: {
                t: WELCOME, yourId: id, room: this.code, seed: this.seed, now: this.now,
                players: [...this.peers.values()].map((p) => ({
                    id: p.id, name: p.name, health: p.health, alive: p.alive,
                    kills: p.kills, deaths: p.deaths,
                })),
            },
        }];
        // Told to everyone including the joiner: the joiner's own `welcome` already
        // lists them, so this is redundant for them and simpler for everyone else than
        // maintaining an "everyone except" send.
        out.push({ to: null, m: { t: JOINED, id, name } });
        return out;
    }

    _state(id, m) {
        const p = this.peers.get(id);
        if (!p || !m.s || typeof m.s !== "object") return [];
        p.state = m.s;
        p.lastSeen = this.now;
        // Not forwarded here. States are batched into the 20 Hz snapshot instead, so a
        // client sending at 60 Hz cannot make everyone else's bandwidth its problem.
        return [];
    }

    /**
     * A client claims it hit someone.
     *
     * Bounds-checked, not verified. Verifying would mean simulating both players'
     * positions and blade arcs on the server, which is the entire architecture the
     * no-anti-cheat decision bought us out of. What is checked is that the target
     * exists, is alive, and that the damage is inside the range any real attack could
     * produce — a bug that claims four thousand is worth stopping.
     */
    _hit(id, m) {
        const attacker = this.peers.get(id);
        const victim = this.peers.get(m.id);
        if (!attacker || !victim || !victim.alive) return [];
        if (victim === attacker) return [];

        const amount = clampDamage(m.d);
        if (amount <= 0) return [];
        return this._applyDamage(victim, amount, attacker, clampImpulse(m.kb));
    }

    /** Relayed as-is: a clash costs nobody health, so there is nothing to arbitrate. */
    _clash(id, m) {
        if (!this.peers.has(id) || !this.peers.has(m.id)) return [];
        return [{ to: null, m: { t: CLASH, by: id, id: m.id } }];
    }

    /**
     * A cast.
     *
     * The cooldown is checked here and nowhere else that matters. A client that asks
     * early is told its real cooldown state and the cast is dropped — which also
     * quietly fixes the case where a client's clock has drifted.
     */
    _cast(id, m) {
        const p = this.peers.get(id);
        if (!p || !p.alive || !isSpellId(m.s)) return [];
        if (this.now < p.ready[m.s]) {
            return [{ to: id, m: { t: COOLDOWNS, ready: p.ready.slice(1), now: this.now } }];
        }
        p.ready[m.s] = this.now + SPELL_COOLDOWN;

        const out = [{
            to: null,
            m: { t: CAST_RELAY, by: id, s: m.s, o: m.o, a: m.a, at: this.now },
        }];
        out.push({ to: id, m: { t: COOLDOWNS, ready: p.ready.slice(1), now: this.now } });
        return out;
    }

    /**
     * A status effect landing on someone.
     *
     * Relayed with an absolute expiry rather than a duration. A duration has to be
     * turned into a deadline by the receiver, using its own clock, at whatever moment
     * the message happens to arrive — so a 3 second slow becomes 3 seconds *plus* the
     * latency, and differently for each of the four clients. An expiry is the same
     * instant for everybody.
     */
    _effectHit(id, m) {
        const from = this.peers.get(id);
        const victim = this.peers.get(m.id);
        if (!from || !victim || !victim.alive) return [];
        if (!Number.isInteger(m.e) || m.e < 0 || m.e > 4) return [];
        const seconds = Math.min(10, Math.max(0, Number(m.s) || 0));
        const magnitude = Math.min(10, Math.max(0, Number(m.m) || 0));
        return [{
            to: null,
            m: {
                t: EFFECT, id: victim.id, e: m.e, m: magnitude,
                endsAt: this.now + seconds, by: id, sp: m.sp,
            },
        }];
    }

    /** Health, death and the kill credit, all in one place. */
    _applyDamage(victim, amount, attacker, kb) {
        victim.health = Math.max(0, victim.health - amount);
        victim.lastHitBy = attacker ? attacker.id : null;

        const out = [{
            to: null,
            m: {
                t: HEALTH, id: victim.id, hp: victim.health,
                by: attacker ? attacker.id : null, d: amount,
                kb: kb || undefined,
            },
        }];

        if (victim.health <= 0 && victim.alive) {
            victim.alive = false;
            victim.deadAt = this.now;
            victim.respawnAt = this.now + RESPAWN_TIME;
            victim.deaths++;
            // Self-inflicted deaths do not pay. Updraft can drop you off a ridge and
            // the crystal field is yours to stand in; neither should read as a kill.
            if (attacker && attacker !== victim) attacker.kills++;
            out.push({
                to: null,
                m: {
                    t: DIED, id: victim.id, by: attacker ? attacker.id : null,
                    respawnAt: victim.respawnAt,
                    score: this.scores(),
                },
            });
        }
        return out;
    }

    /**
     * Damage from a source that is not another player — a burn tick, a fall.
     *
     * Separate entry point because the claim path requires a live attacker and this
     * has none.
     */
    damageFrom(victimId, amount, attackerId) {
        const victim = this.peers.get(victimId);
        if (!victim || !victim.alive) return [];
        const attacker = attackerId ? this.peers.get(attackerId) : null;
        // Not run through the claim clamp. That bound exists to stop a *client* asking
        // for something absurd; this path is the authority acting on its own behalf, and
        // a fall or a drowning is entitled to take a full bar at once.
        const n = Number(amount);
        if (!Number.isFinite(n) || n <= 0) return [];
        return this._applyDamage(victim, Math.min(MAX_HEALTH, n), attacker || null, null);
    }

    /**
     * Advance the room clock and emit whatever falls out of it.
     *
     * @param {number} dt seconds
     */
    tick(dt) {
        this.now += dt;
        const out = [];

        for (const p of this.peers.values()) {
            if (!p.alive && this.now >= p.respawnAt) {
                p.alive = true;
                p.health = MAX_HEALTH;
                p.lastHitBy = null;
                // Where they come back is the client's business — it owns positions, and
                // it knows where the living are. The authority only says "you are back".
                out.push({ to: null, m: { t: SPAWNED, id: p.id, hp: MAX_HEALTH } });
            }
        }

        this._sinceSnapshot += dt;
        const interval = 1 / 20;
        if (this._sinceSnapshot >= interval) {
            this._sinceSnapshot -= interval;
            // Snapped rather than accumulated: after a long stall, replaying the backlog
            // one snapshot per frame would send a burst of stale positions.
            if (this._sinceSnapshot > interval) this._sinceSnapshot = 0;
            const s = {};
            let any = false;
            for (const p of this.peers.values()) {
                if (!p.state) continue;
                s[p.id] = p.state;
                any = true;
            }
            if (any) out.push({ to: null, m: { t: SNAPSHOT, at: this.now, s } });
        }

        return out;
    }

    /** Drop anyone who has stopped talking. */
    reap() {
        const out = [];
        for (const p of [...this.peers.values()]) {
            if (this.now - p.lastSeen > TIMEOUT) out.push(...this.drop(p.id));
        }
        return out;
    }

    /** @param {string} id */
    drop(id) {
        const p = this.peers.get(id);
        if (!p) return [];
        this.peers.delete(id);
        return [{ to: null, m: { t: LEFT, id, score: this.scores() } }];
    }

    scores() {
        return [...this.peers.values()]
            .map((p) => p.scoreLine())
            .sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    }
}

/**
 * Bound an impulse.
 *
 * Same reasoning as the damage clamp: not anti-cheat, but a bug that sends a velocity of
 * ten thousand would fire someone off the map and there is no reason to relay it. The cap
 * is well above the hardest knockback in the game, which is Vortex at 10 m/s.
 */
function clampImpulse(kb) {
    if (!Array.isArray(kb) || kb.length !== 3) return null;
    const out = [];
    for (let i = 0; i < 3; i++) {
        const n = Number(kb[i]);
        if (!Number.isFinite(n)) return null;
        out.push(Math.max(-25, Math.min(25, n)));
    }
    if (out[0] === 0 && out[1] === 0 && out[2] === 0) return null;
    return out;
}

function clampDamage(d) {
    const n = Number(d);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(MAX_CLAIM_DAMAGE, n);
}

/**
 * Make a display name safe.
 *
 * Trimmed, length-capped, and stripped of anything that is not printable. The HUD puts
 * these in the DOM as `textContent`, which cannot execute markup — but nameplates are
 * also the one string a stranger controls, so control characters and 200-character
 * names are worth refusing here rather than trusting every future consumer to.
 */
export function cleanName(raw, fallback) {
    if (typeof raw !== "string") return fallback;
    const cleaned = raw.replace(/[^\x20-\x7E]/g, "").trim().slice(0, 16);
    return cleaned.length > 0 ? cleaned : fallback;
}

/**
 * The set of rooms.
 */
export class Lobby {
    constructor(seedFor = () => (Math.random() * 1e9) | 0) {
        /** @type {Map<string, Room>} */
        this.rooms = new Map();
        this._seedFor = seedFor;
    }

    /**
     * Find a room, or make it.
     *
     * Rooms are created on demand by whoever arrives first, which is what makes a link
     * with an unknown code in it work rather than fail — the host does not have to
     * "open" anything.
     */
    room(code) {
        if (!validRoomCode(code)) return null;
        let r = this.rooms.get(code);
        if (!r) {
            r = new Room(code, this._seedFor(code));
            this.rooms.set(code, r);
        }
        return r;
    }

    /** Advance every room, and forget the empty ones. */
    tick(dt) {
        const out = [];
        for (const [code, room] of this.rooms) {
            out.push(...room.tick(dt).map((o) => ({ room, ...o })));
            out.push(...room.reap().map((o) => ({ room, ...o })));
            if (room.peers.size === 0) this.rooms.delete(code);
        }
        return out;
    }
}
