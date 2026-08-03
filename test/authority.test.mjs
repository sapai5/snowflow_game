/**
 * The authority.
 *
 * The whole reason `authority.mjs` has no sockets in it. Four browsers over a tunnel is
 * the worst possible place to discover that a kill was credited to the wrong player;
 * here it is a function call.
 *
 * What is asserted is the short list of facts four clients cannot be allowed to disagree
 * about: health, who is dead, who gets the credit, and when a spell is ready.
 */
import { Room, Lobby, ROOM_CAPACITY, cleanName } from "../server/authority.mjs";
import {
    msg, PROTOCOL_VERSION, WELCOME, SNAPSHOT, HEALTH, DIED, SPAWNED, COOLDOWNS,
    EFFECT, JOINED, LEFT, REJECTED, CAST_RELAY, CLASH,
} from "../src/net/protocol.js";
import { MAX_HEALTH, RESPAWN_TIME, SPELL_COOLDOWN, MAX_CLAIM_DAMAGE } from "../src/game/rules.js";
import { suite } from "./harness.mjs";

/** Join `n` players and hand back their ids. */
function seat(room, n) {
    const ids = [];
    for (let i = 0; i < n; i++) {
        const out = room.handle(null, msg.join(room.code, "p" + i));
        const w = out.find((o) => o.m.t === WELCOME);
        ids.push(w.m.yourId);
    }
    return ids;
}

/** Run the room clock for `secs`, collecting everything it emits. */
function run(room, secs) {
    const out = [];
    const dt = 1 / 60;
    for (let i = 0; i < Math.round(secs / dt); i++) out.push(...room.tick(dt));
    return out;
}

const of = (out, t) => out.filter((o) => o.m.t === t).map((o) => o.m);

export async function runRoom() {
    const { ok, result } = suite();

    // ---- joining -----------------------------------------------------------
    {
        const room = new Room("SNOW-TEST", 1234);
        const out = room.handle(null, msg.join("SNOW-TEST", "Ada"));
        const w = of(out, WELCOME)[0];
        ok(w !== undefined, "a join is welcomed");
        ok(w.yourId === "p1", "and told its own id, got " + w.yourId);
        ok(w.seed === 1234, "and the seed, so everyone stands on the same mountain");
        ok(of(out, JOINED).length === 1, "and everyone is told somebody arrived");
        ok(w.players.length === 1 && w.players[0].name === "Ada",
            "the roster comes with the welcome");
    }

    // ---- the fifth player ---------------------------------------------------
    {
        const room = new Room("SNOW-FULL", 1);
        seat(room, ROOM_CAPACITY);
        ok(room.full, "four fills a room");
        const out = room.handle(null, msg.join("SNOW-FULL", "late"));
        ok(of(out, REJECTED)[0]?.why === "full",
            "and the fifth is told so rather than silently ignored");
        ok(room.peers.size === ROOM_CAPACITY, "and is not seated anyway");
    }

    // ---- version skew ------------------------------------------------------
    {
        const room = new Room("SNOW-VER", 1);
        const out = room.handle(null, { t: "join", v: PROTOCOL_VERSION + 1, name: "old" });
        ok(of(out, REJECTED)[0]?.why === "version",
            "a client on the wrong protocol is told which one to be");
        ok(room.peers.size === 0, "and not seated");
    }

    // ---- health is the server's -------------------------------------------
    {
        const room = new Room("SNOW-HP", 1);
        const [a, b] = seat(room, 2);
        const out = room.handle(a, msg.hit(b, 9, "sword", 1));
        const h = of(out, HEALTH)[0];
        ok(h !== undefined, "a hit claim produces a health ruling");
        ok(h.hp === MAX_HEALTH - 9, "with the arithmetic done here, got " + h.hp);
        ok(h.by === a, "and the credit recorded");
        ok(room.peers.get(b).health === MAX_HEALTH - 9, "the room holds the new value");
    }

    // ---- a claim cannot be unbounded ---------------------------------------
    {
        const room = new Room("SNOW-BOUND", 1);
        const [a, b] = seat(room, 2);
        const h = of(room.handle(a, msg.hit(b, 99999, "sword", 1)), HEALTH)[0];
        ok(h.hp === MAX_HEALTH - MAX_CLAIM_DAMAGE,
            "an absurd claim is clamped rather than honoured, got " + h.hp);
        // Not because anyone is expected to cheat — clients are trusted by decision —
        // but because a client with a bug should not end everyone else's session.
        ok(of(room.handle(a, msg.hit(b, -50, "sword", 1)), HEALTH).length === 0,
            "and healing by claiming negative damage is not a thing");
    }

    // ---- you cannot hit yourself, or the dead ------------------------------
    {
        const room = new Room("SNOW-SELF", 1);
        const [a, b] = seat(room, 2);
        ok(of(room.handle(a, msg.hit(a, 9, "sword", 1)), HEALTH).length === 0,
            "a self-hit claim is dropped");
        for (let i = 0; i < 20; i++) room.handle(a, msg.hit(b, 9, "sword", 1));
        ok(!room.peers.get(b).alive, "twenty light hits is a death");
        ok(of(room.handle(a, msg.hit(b, 9, "sword", 1)), HEALTH).length === 0,
            "and a corpse takes no further damage");
    }

    // ---- death, credit, and the score -------------------------------------
    {
        const room = new Room("SNOW-KILL", 1);
        const [a, b] = seat(room, 2);
        let died = null;
        for (let i = 0; i < 12; i++) {
            const got = of(room.handle(a, msg.hit(b, 9, "sword", 1)), DIED)[0];
            if (got) { died = got; break; }
        }
        ok(died !== null, "enough hits kill");
        ok(died.by === a, "the killer is named");
        ok(room.peers.get(a).kills === 1, "and credited exactly once");
        ok(room.peers.get(b).deaths === 1, "the victim's deaths go up");
        ok(Math.abs(died.respawnAt - (room.now + RESPAWN_TIME)) < 1e-9,
            "and the respawn instant is absolute, not a duration");
        ok(died.score[0].id === a, "the scoreboard rides along, leader first");
    }

    // ---- a death with no killer pays nobody --------------------------------
    {
        const room = new Room("SNOW-SUICIDE", 1);
        const [a] = seat(room, 1);
        room.damageFrom(a, 200, a);
        ok(!room.peers.get(a).alive, "you can kill yourself");
        ok(room.peers.get(a).kills === 0,
            "and it does not count as a kill — updraft off a ridge is not an achievement");
        ok(room.peers.get(a).deaths === 1, "but it is a death");
    }

    // ---- respawn happens on the clock -------------------------------------
    {
        const room = new Room("SNOW-BACK", 1);
        const [a, b] = seat(room, 2);
        for (let i = 0; i < 12; i++) room.handle(a, msg.hit(b, 9, "sword", 1));
        ok(!room.peers.get(b).alive, "down");
        const early = of(run(room, RESPAWN_TIME - 0.5), SPAWNED);
        ok(early.length === 0, "still down half a second early");
        const back = of(run(room, 1), SPAWNED);
        ok(back.length === 1 && back[0].id === b, "and up on time");
        ok(room.peers.get(b).health === MAX_HEALTH, "at full health");
        ok(room.peers.get(b).alive, "and alive");
    }

    // ---- cooldowns are the server's --------------------------------------
    {
        const room = new Room("SNOW-CD", 1);
        const [a] = seat(room, 1);
        const first = room.handle(a, msg.cast(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
        ok(of(first, CAST_RELAY).length === 1, "a cast off cooldown is relayed");
        ok(of(first, COOLDOWNS)[0].ready[0] === SPELL_COOLDOWN,
            "and the caster is told when it is next ready");

        const second = room.handle(a, msg.cast(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 }));
        ok(of(second, CAST_RELAY).length === 0, "a second cast inside 45 s is refused");
        ok(of(second, COOLDOWNS).length === 1,
            "and the client is told the real state rather than left guessing");

        run(room, SPELL_COOLDOWN + 0.1);
        ok(of(room.handle(a, msg.cast(1, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 })), CAST_RELAY).length === 1,
            "and it works again once the timer is up");
    }

    // ---- a spell id that does not exist -----------------------------------
    {
        const room = new Room("SNOW-BADSPELL", 1);
        const [a] = seat(room, 1);
        for (const bad of [0, 6, -1, 2.5, "1", null]) {
            const out = room.handle(a, { t: "cast", s: bad, o: [0, 0, 0], a: [0, 0, 1] });
            ok(of(out, CAST_RELAY).length === 0, "spell id " + String(bad) + " is refused");
        }
    }

    // ---- effects arrive as deadlines, not durations -----------------------
    {
        const room = new Room("SNOW-FX", 1);
        const [a, b] = seat(room, 2);
        run(room, 5); // the clock is not zero, which is the point
        const e = of(room.handle(a, msg.effectHit(b, 0, 0.4, 3, 1)), EFFECT)[0];
        ok(e !== undefined, "an effect claim is relayed");
        ok(Math.abs(e.endsAt - (room.now + 3)) < 1e-9,
            "as an absolute expiry: a duration would become three seconds plus the " +
            "latency, differently for each client");
        ok(e.m === 0.4, "with its magnitude");
    }

    // ---- a clash costs nobody health --------------------------------------
    {
        const room = new Room("SNOW-CLASH", 1);
        const [a, b] = seat(room, 2);
        const out = room.handle(a, msg.clash(b));
        ok(of(out, CLASH).length === 1, "a clash is relayed to everyone");
        ok(of(out, HEALTH).length === 0, "and changes no health, so there is nothing to arbitrate");
        ok(room.peers.get(b).health === MAX_HEALTH, "both walk away whole");
    }

    // ---- snapshots ---------------------------------------------------------
    {
        const room = new Room("SNOW-SNAP", 1);
        const [a, b] = seat(room, 2);
        room.handle(a, msg.state({ x: 1, y: 0, z: 2, f: 0 }));
        room.handle(b, msg.state({ x: 3, y: 0, z: 4, f: 1 }));

        const oneSecond = of(run(room, 1), SNAPSHOT);
        ok(oneSecond.length >= 19 && oneSecond.length <= 21,
            "snapshots come at 20 Hz, got " + oneSecond.length + " in a second");
        const s = oneSecond[0].s;
        ok(s[a] && s[b], "carrying every player who has reported a position");
        ok(s[a].x === 1 && s[b].z === 4, "verbatim — the relay does not interpret movement");
        ok(typeof oneSecond[0].at === "number", "stamped with server time, for interpolation");

        // A client sending faster than the snapshot rate must not make everyone else's
        // bandwidth its problem.
        const before = room.now;
        for (let i = 0; i < 60; i++) room.handle(a, msg.state({ x: i, y: 0, z: 0, f: 0 }));
        ok(room.now === before, "sixty state messages do not advance anything");
    }

    // ---- leaving -----------------------------------------------------------
    {
        const room = new Room("SNOW-LEAVE", 1);
        const [a, b] = seat(room, 2);
        const out = room.drop(a);
        ok(of(out, LEFT)[0].id === a, "a departure is announced");
        ok(room.peers.size === 1, "and the seat freed");
        ok(of(room.drop(a), LEFT).length === 0, "dropping twice says nothing");
    }

    // ---- a silent client is reaped ----------------------------------------
    {
        const room = new Room("SNOW-QUIET", 1);
        const [a, b] = seat(room, 2);
        // One keeps talking, the other stops.
        for (let i = 0; i < 60 * 20; i++) {
            room.tick(1 / 60);
            if (i % 20 === 0) room.handle(a, msg.state({ x: 0, y: 0, z: 0, f: 0 }));
        }
        const left = room.reap();
        ok(room.peers.has(a), "the client that kept talking is still here");
        ok(!room.peers.has(b), "the one that went quiet is gone");
    }

    // ---- names -------------------------------------------------------------
    {
        ok(cleanName("Ada", "p1") === "Ada", "an ordinary name survives");
        ok(cleanName("", "p1") === "p1", "an empty one falls back to the id");
        ok(cleanName(null, "p1") === "p1", "so does a missing one");
        ok(cleanName("x".repeat(200), "p1").length === 16, "a long one is cut to 16");
        ok(cleanName("a\u0000b\u001bc", "p1") === "abc",
            "and control characters are dropped: this string ends up in the DOM");
        ok(cleanName("  spaced  ", "p1") === "spaced", "trimmed");
    }

    // ---- the lobby ---------------------------------------------------------
    {
        const lobby = new Lobby(() => 77);
        const r1 = lobby.room("SNOW-AAAA");
        ok(r1 !== null, "a room is created by whoever arrives first");
        ok(lobby.room("SNOW-AAAA") === r1, "and found by the next arrival");
        ok(r1.seed === 77, "with a seed everyone in it shares");
        ok(lobby.room("../etc/passwd") === null, "a nonsense code is refused");
        ok(lobby.room("") === null, "so is an empty one");

        seat(r1, 1);
        lobby.tick(1 / 60);
        ok(lobby.rooms.has("SNOW-AAAA"), "an occupied room stays");
        r1.drop("p1");
        lobby.tick(1 / 60);
        ok(!lobby.rooms.has("SNOW-AAAA"), "an empty one is forgotten");
    }

    return result();
}
