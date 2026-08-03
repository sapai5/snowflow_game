/**
 * Two clients and an authority, end to end.
 *
 * The suites either side of this one test the halves: `authority` checks the rulings and
 * `remote` checks the interpolation. Neither would catch the failures that only exist
 * *between* them — a claim built with one key and read with another, an impulse that
 * survives the server but never reaches the victim, a cooldown expressed in the wrong
 * clock. Those are the expensive bugs, because they look like lag.
 *
 * No sockets: the authority's output is handed straight to the clients' receive path,
 * which is exactly what `relay.mjs` does with a socket in the middle.
 */
import { Room } from "../server/authority.mjs";
import { NetClient } from "../src/net/client.js";
import {
    msg, WELCOME, HEALTH, DIED, SPAWNED, EFFECT, COOLDOWNS, SNAPSHOT, encodeState,
} from "../src/net/protocol.js";
import { MAX_HEALTH, SPELL_COOLDOWN, SLOW } from "../src/game/rules.js";
import { suite, mkPlayer } from "./harness.mjs";

/**
 * A world stub with the surface the net client actually touches.
 *
 * Deliberately not the real `World`: that needs a scene, a terrain and a GPU. What the
 * client uses of it is a player table, a clock, and a resolver it can switch out of
 * authority — all of which are here for real.
 */
function mkNetWorld(localId) {
    const players = new Map();
    const local = mkPlayer(localId, 0, 0);
    local.isLocal = true;
    players.set(localId, local);

    const combat = {
        events: [],
        authoritative: true,
        ownerId: null,
        killed: [],
        impulses: [],
        clashes: [],
        casts: [],
        kill(p, by) { p.alive = false; p.health = 0; this.killed.push({ id: p.id, by }); },
        applyImpulse(p, x, y, z) { this.impulses.push({ id: p.id, x, y, z }); },
        applyClash(a, b) { this.clashes.push([a.id, b.id]); },
        cast(caster, id) { this.casts.push({ by: caster.id, id }); },
        rekey() {},
    };

    return {
        players, local, combat, now: 0,
        spawn({ id, name }) {
            const p = mkPlayer(id, 0, 0);
            p.name = name;
            players.set(id, p);
            return p;
        },
        despawn(id) { players.delete(id); },
        rekey(p, id) { players.delete(p.id); p.id = id; players.set(id, p); },
        respawnLocal(p) { p.respawned = true; },
    };
}

/** A client with its socket replaced by a list of what it tried to send. */
function mkClient(world, room) {
    const sent = [];
    const c = new NetClient(world, { room: "SNOW-E2E", name: "n" });
    c._send = (m) => sent.push(m);
    c.connected = true;
    c.sent = sent;
    return c;
}

/**
 * Push everything the authority produced into whichever clients should hear it.
 *
 * A welcome is addressed to an id the recipient does not know yet — which is why the
 * real relay answers on the socket the join arrived on rather than by looking the id up.
 * This is that, expressed against a list.
 */
function deliver(out, clients) {
    for (const item of out) {
        for (const c of clients) {
            const mine = item.to === null
                || item.to === c.localId
                || (c.localId === null && item.m.t === WELCOME);
            if (mine) c._receive(item.m);
        }
    }
}

export async function run() {
    const { ok, result } = suite();

    // Two clients, one room. Each starts as a single-player world that then joins.
    //
    // The room has already been up for half a minute when they arrive, which is the
    // normal case and not an edge one: somebody opens the link second. It matters here
    // because every ruling the authority sends is stamped in *its* clock, and both
    // clients' clocks start at zero — so a session that only ever tested a server whose
    // clock happened to agree with the client's would pass while being completely wrong
    // about durations.
    const room = new Room("SNOW-E2E", 4242);
    for (let i = 0; i < 60 * 30; i++) room.tick(1 / 60);
    const wa = mkNetWorld("local-a");
    const wb = mkNetWorld("local-b");
    const ca = mkClient(wa);
    const cb = mkClient(wb);

    // ---- joining -----------------------------------------------------------
    {
        deliver(room.handle(null, msg.join("SNOW-E2E", "Ada")), [ca]);
        ok(ca.localId === "p1", "the first client learns its id, got " + ca.localId);
        ok(wa.local.id === "p1",
            "and the player it already had adopts it rather than being replaced");
        ok(wa.players.has("p1"), "so the table is keyed by the authority's id");
        ok(ca.seed === 4242, "and everyone gets the same seed");
        ok(wa.combat.authoritative === false,
            "from here the client stops owning health");
        ok(wa.combat.ownerId === "p1",
            "and resolves only its own blade — four clients claiming one hit is four " +
            "times the damage");

        // The second client joins, and both learn about each other.
        const out = room.handle(null, msg.join("SNOW-E2E", "Bo"));
        deliver(out, [ca, cb]);
        ok(cb.localId === "p2", "the second client gets its own id");
        ok(wa.players.has("p2"), "the first sees the second arrive");
        ok(wa.players.get("p2").remote === true, "as a remote player");
        ok(wb.players.has("p1"), "and the second sees the first, from the welcome roster");
        ok(ca.names.get("p2") === "Bo", "names come across for the nameplates");
    }

    // ---- a hit, claimed and ruled on ---------------------------------------
    {
        // p1's resolver found a hit on p2 and pushed the event the HUD also reads.
        wa.combat.events = [{
            kind: "hit", by: "p1", on: "p2", stage: 1, amount: 9,
            kb: [2.5, 0, 0], x: 0, y: 1, z: 0,
        }];
        ca._sendClaims();
        const claim = ca.sent.find((m) => m.t === "hit");
        ok(claim !== undefined, "a local hit becomes a claim");
        ok(claim.id === "p2" && claim.d === 9, "naming the victim and the amount");
        ok(claim.kb[0] === 2.5, "and carrying the impulse the attacker computed");

        deliver(room.handle("p1", claim), [ca, cb]);
        ok(wa.players.get("p2").health === MAX_HEALTH - 9,
            "the attacker's client shows the server's number, got " +
            wa.players.get("p2").health);
        ok(wb.local.health === MAX_HEALTH - 9,
            "and so does the victim's own client");
        ok(wb.combat.impulses.length === 1,
            "the victim applies the shove itself, because it owns where it is");
        ok(wa.combat.impulses.length === 0,
            "and the attacker does not apply it to them — that would be a rubber band, " +
            "overwritten by the victim's next snapshot");
    }

    // ---- damage claimed by somebody else is not doubled --------------------
    {
        const before = wb.local.health;
        // The same event, if the *victim's* client had also resolved it. It must not
        // produce a claim: `by` is not us.
        wb.combat.events = [{
            kind: "hit", by: "p1", on: "p2", stage: 1, amount: 9, kb: [0, 0, 0], x: 0, y: 1, z: 0,
        }];
        const n = cb.sent.length;
        cb._sendClaims();
        ok(cb.sent.length === n,
            "a client does not claim a hit it did not make");
        ok(wb.local.health === before, "so no health moves twice");
    }

    // ---- a spell: one event, two claims -----------------------------------
    {
        wa.combat.events = [{
            kind: "spellHit", by: "p1", on: "p2", spell: 1, amount: 10,
            effect: SLOW, magnitude: 0.4, seconds: 3,
            kb: [8, 0, 0], x: 0, y: 1, z: 0,
        }];
        ca.sent.length = 0;
        ca._sendClaims();
        ok(ca.sent.filter((m) => m.t === "hit").length === 1, "a spell hit claims damage");
        const fx = ca.sent.find((m) => m.t === "effectHit");
        ok(fx !== undefined,
            "and its status effect separately — the victim never resolved the volume, " +
            "so without this it would never learn it had been slowed");
        ok(fx.e === SLOW && fx.s === 3, "with the type and duration");

        deliver(room.handle("p1", fx), [ca, cb]);
        const secs = wb.local.effects.remaining(SLOW);
        ok(secs > 0, "the victim applies the effect");
        ok(Math.abs(secs - 3) < 0.05,
            "for three seconds in its own clock — not the thirty-three a raw server " +
            "timestamp would give: got " + secs.toFixed(3));
        ok(wb.local.effects.moveScale < 1, "and it actually slows them down");
    }

    // ---- a cast is relayed and rebuilt ------------------------------------
    {
        ca.sent.length = 0;
        wa.combat.events = [{
            kind: "cast", by: "p1", spell: 4,
            origin: { x: 1, y: 2, z: 3 }, aim: { x: 0, y: 0, z: 1 },
        }];
        ca._sendClaims();
        const cast = ca.sent.find((m) => m.t === "cast");
        ok(cast !== undefined, "a cast is reported");
        ok(cast.o[0] === 1 && cast.a[2] === 1,
            "with the origin and aim, so every client builds the identical zone");

        let heard = null;
        cb.onEvent = (kind, data) => { if (kind === "cast") heard = data; };
        deliver(room.handle("p1", cast), [ca, cb]);
        ok(heard !== null, "and the other client hears it");
        ok(heard.by === "p1" && heard.s === 4, "attributed and identified");
    }

    // ---- cooldowns come from the server, in our clock --------------------
    {
        const cd = ca.sent.length;
        // The authority already put spell 4 on cooldown from the cast above.
        const ready = ca.world.local.cooldowns[3];
        ok(ready > ca.world.now,
            "the cast put the spell on cooldown in local time, got " + ready.toFixed(1));
        ok(Math.abs(ready - (ca.world.now + SPELL_COOLDOWN)) < 0.5,
            "45 seconds from now, not 45 seconds from the server's epoch");
    }

    // ---- a clash staggers both, once -------------------------------------
    {
        ca.sent.length = 0;
        wa.combat.events = [{ kind: "clash", by: "p1", on: "p2", x: 0, y: 1, z: 0 }];
        ca._sendClaims();
        const clash = ca.sent.find((m) => m.t === "clash");
        ok(clash !== undefined, "a clash is reported");
        deliver(room.handle("p1", clash), [ca, cb]);
        ok(wb.combat.clashes.length === 1, "the other client applies it");
        ok(wa.combat.clashes.length === 1,
            "and so does the one that detected it — idempotent, because a stagger takes " +
            "the longer of the two timers");
    }

    // ---- snapshots move a remote player ----------------------------------
    {
        wa.local.controller.position.set(5, 0, 7);
        wa.local.controller.facing = 0.75;
        room.handle("p1", msg.state(encodeState(wa.local)));
        // Two snapshots, because interpolation needs something to interpolate between.
        deliver(room.tick(1 / 20), [ca, cb]);
        wa.local.controller.position.set(6, 0, 7);
        room.handle("p1", msg.state(encodeState(wa.local)));
        deliver(room.tick(1 / 20), [ca, cb]);

        const ghost = wb.players.get("p1");
        wb.now = 10;
        cb.applyRemotes(wb.now);
        ok(ghost.controller.position.x > 4,
            "the remote player is where its owner said, got " +
            ghost.controller.position.x.toFixed(2));
        ok(Math.abs(ghost.controller.facing - 0.75) < 0.01,
            "facing the way its owner is facing");
    }

    // ---- death, credit, respawn ------------------------------------------
    {
        for (let i = 0; i < 12; i++) {
            deliver(room.handle("p1", msg.hit("p2", 9, "sword", 1, [0, 0, 0])), [ca, cb]);
        }
        ok(!wb.local.alive, "enough claims kill the victim");
        ok(wb.combat.killed.length === 1, "on the victim's own client");
        ok(wa.players.get("p2").alive === false, "and on the attacker's");
        ok(ca.scores.length === 2 && ca.scores[0].id === "p1",
            "the scoreboard arrives with the death, leader first");
        ok(ca.scores[0].kills === 1, "credited once");

        deliver(room.tick(4.01), [ca, cb]);
        ok(wb.local.alive, "and four seconds later they are back");
        ok(wb.local.health === MAX_HEALTH, "at full health");
        ok(wb.local.respawned === true,
            "having chosen their own spot, because a client owns where it is");
        ok(wa.players.get("p2").alive === true, "the other client agrees they are up");
    }

    // ---- leaving ----------------------------------------------------------
    {
        deliver(room.drop("p2"), [ca]);
        ok(!wa.players.has("p2"), "a departure removes the player");
        ok(!ca.driver.tracks.has("p2"),
            "and their snapshot history, so a rejoin does not inherit an old position");
    }

    return result();
}
