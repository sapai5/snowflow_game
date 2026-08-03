/**
 * The wire protocol.
 *
 * One file, imported by both the browser client and the Node authority, so a message
 * cannot be built one way and read another. Every message is `{ t: <type>, ... }` and
 * every type is a constant in here rather than a string literal at a call site —
 * misspelling `"snapshot"` as `"snapshsot"` is otherwise a silent no-op that looks
 * exactly like a network problem.
 *
 * JSON, not a binary packing, and deliberately: four players at 20 Hz is about 16 KB/s
 * of JSON against maybe 3 KB/s packed, and neither number matters over a tunnel. What
 * does matter is that a session can be debugged by reading the frames in a browser's
 * network panel. A packed format would be the right answer at forty players; at four it
 * buys nothing and costs every future change a serialiser edit.
 *
 * Positions and angles are rounded on the way out. Sub-millimetre precision on a
 * position that will be interpolated anyway is pure payload — the rounding is not for
 * bandwidth so much as for readable logs.
 */

/** Bumped whenever a message shape changes incompatibly. */
export const PROTOCOL_VERSION = 1;

// ------------------------------------------------------------ client → server

export const JOIN = "join";
export const STATE = "state";
export const HIT = "hit";
export const CLASH = "clash";
export const CAST = "cast";
export const EFFECT_HIT = "effectHit";
export const PING = "ping";

// ------------------------------------------------------------ server → client

export const WELCOME = "welcome";
export const SNAPSHOT = "snapshot";
export const HEALTH = "health";
export const DIED = "died";
export const SPAWNED = "spawned";
export const CAST_RELAY = "cast";
export const EFFECT = "effect";
export const COOLDOWNS = "cooldowns";
export const JOINED = "joined";
export const LEFT = "left";
export const PONG = "pong";
export const REJECTED = "rejected";

/** Snapshots per second. */
export const SNAPSHOT_HZ = 20;
/** How far behind the newest snapshot remotes are drawn, seconds. */
export const INTERP_DELAY = 0.1;

/**
 * Flags packed into one integer.
 *
 * A bitfield rather than five booleans because these travel 20 times a second per
 * player and they are genuinely a set of independent bits; the JSON for
 * `{"surf":true,"air":false,...}` is longer than the entire rest of the state message.
 */
export const F_SURF = 1 << 0;
export const F_AIR = 1 << 1;
export const F_SPRINT = 1 << 2;
export const F_DEAD = 1 << 3;

const r2 = (n) => Math.round(n * 100) / 100;
const r3 = (n) => Math.round(n * 1000) / 1000;

/**
 * One player's movement state.
 *
 * `swingStage` and `swingT` are here because a remote client needs them for two
 * separate reasons: to pose the swing, and to know whether that blade is inside its
 * strike window — which is what makes parry-by-clash detectable without the server
 * simulating anything.
 *
 * @param {import("../game/player.js").Player} p
 */
export function encodeState(p) {
    const c = p.controller;
    let flags = 0;
    if (c.surfActive) flags |= F_SURF;
    if (c.airborne) flags |= F_AIR;
    if (c.intent && c.intent.sprint) flags |= F_SPRINT;
    if (!p.alive) flags |= F_DEAD;

    return {
        x: r2(c.position.x), y: r2(c.position.y), z: r2(c.position.z),
        vx: r2(c.velocity.x), vy: r2(c.velocity.y), vz: r2(c.velocity.z),
        f: r3(c.facing),
        // Where they are aiming, which is not where they are facing while strafing.
        a: r3(c.intent && c.intent.aimYaw !== null && c.intent.aimYaw !== undefined
            ? c.intent.aimYaw
            : c.facing),
        fl: flags,
        st: p.combat.stage,
        // The phase clock, needed to place the blade inside or outside its strike
        // window. Three decimals is a millisecond, which is finer than the 50 ms
        // snapshot interval can justify — but it is compared against fixed stage
        // timings, and rounding it coarsely would move the window itself.
        sw: r3(p.combat.t),
    };
}

/** @param {object} s a state as produced by `encodeState` */
export function stateFlags(s) {
    return {
        surf: !!(s.fl & F_SURF),
        air: !!(s.fl & F_AIR),
        sprint: !!(s.fl & F_SPRINT),
        dead: !!(s.fl & F_DEAD),
    };
}

// --------------------------------------------------------------- constructors
//
// Trivial, and worth having anyway: every one of these is a place where a key could be
// misspelled on one side of the socket and never noticed.

export const msg = {
    join: (room, name) => ({ t: JOIN, v: PROTOCOL_VERSION, room, name }),
    state: (s) => ({ t: STATE, s }),
    hit: (targetId, damage, kind, stage, kb) => ({
        t: HIT, id: targetId, d: damage, k: kind, st: stage,
        // The impulse the blow imparted, for the victim's own client to apply. The
        // attacker computed it because only the attacker knows the geometry of the blow;
        // the victim applies it because only the victim owns where it is.
        kb: kb ? [r2(kb[0]), r2(kb[1]), r2(kb[2])] : undefined,
    }),
    clash: (otherId) => ({ t: CLASH, id: otherId }),
    cast: (spellId, origin, aim) => ({
        t: CAST, s: spellId,
        o: [r2(origin.x), r2(origin.y), r2(origin.z)],
        a: [r3(aim.x), r3(aim.y), r3(aim.z)],
    }),
    effectHit: (targetId, effect, magnitude, seconds, spellId) => ({
        t: EFFECT_HIT, id: targetId, e: effect, m: magnitude, s: seconds, sp: spellId,
    }),
    ping: (clientTime) => ({ t: PING, c: clientTime }),
};

/**
 * Parse a frame off the socket.
 *
 * Returns null rather than throwing on anything malformed. A relay that dies because
 * one client sent a truncated frame is a relay that four people have to restart.
 *
 * @param {string} raw
 */
export function decode(raw) {
    if (typeof raw !== "string" || raw.length === 0) return null;
    let v;
    try {
        v = JSON.parse(raw);
    } catch {
        return null;
    }
    if (!v || typeof v !== "object" || typeof v.t !== "string") return null;
    return v;
}

export function encode(v) {
    return JSON.stringify(v);
}

/**
 * A room code that can be read aloud.
 *
 * No vowels, so it cannot spell anything; no `0`/`O` or `1`/`I`, because the whole
 * point of this string is that it survives being typed from a screenshot or repeated
 * over a voice call.
 */
const CODE_ALPHABET = "23456789BCDFGHJKLMNPQRSTVWXZ";

export function makeRoomCode(rand = Math.random) {
    let out = "";
    for (let i = 0; i < 4; i++) {
        out += CODE_ALPHABET[Math.floor(rand() * CODE_ALPHABET.length)];
    }
    return "SNOW-" + out;
}

/** Is this something a client could plausibly have sent as a room code? */
export function validRoomCode(code) {
    return typeof code === "string" && /^[A-Z0-9-]{3,24}$/.test(code);
}
