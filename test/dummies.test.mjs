/**
 * The practice dummies: do they close, hit, and cast?
 *
 * Worth testing rather than eyeballing, because two of the bugs that made them
 * harmless were invisible from outside — they faced their own sidestep so the blade
 * swept past you, and their casts raised events that were cleared before anyone read
 * them.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { DummyCrowd } from "../src/dev/dummies.js";
import { CombatResolver } from "../src/game/combat.js";
import { CharacterController } from "../src/character/controller.js";
import { makeIntent } from "../src/game/intent.js";
import { suite, mkPlayer, terrain, rig, STAGE } from "./harness.mjs";

const dt = 1 / 60;

const IDLE = makeIntent();

export async function run() {
    const { ok, result } = suite();

    // ---- do they reach you, and can they land a hit? ------------------------
    {
        const mk = (id, x, z) => {
            const p = mkPlayer(id, x, z);
            p.controller = new CharacterController(terrain);
            p.controller.position.set(x, 0, z);
            let last = 0;
            p.combat = {
                stage: 0, t: 0,
                get stageTiming() { return this.stage > 0 ? STAGE : null; },
                interrupt() { this.stage = 0; this.t = 0; },
                update(d, _r, intent) {
                    if (intent && intent.attackPressed && this.stage === 0) { this.stage = 1; this.t = 0; }
                    if (this.stage > 0) { this.t += d; if (this.t > 0.46) { this.stage = 0; this.t = 0; } }
                },
            };
            p.update = function (d, r) {
                // A complete intent, always. A partial one makes the controller's wish
                // vector NaN, which is worth knowing about but is not a live risk: every
                // real caller passes either the input singleton or a `makeIntent`.
                let intent = this.intent || IDLE;
                if (!this.alive || this.effects.locked) intent = IDLE;
                if (this.combat.stage !== last) { if (this.combat.stage > 0) this.struckThisSwing.clear(); last = this.combat.stage; }
                this.controller.moveScale = this.effects.moveScale;
                this.controller.update(d, r, intent);
                this.combat.update(d, r, intent);
                const c = this.controller;
                this.sword._g.set(c.position.x, c.position.y + 1.1, c.position.z);
                this.sword._t.set(
                    c.position.x + Math.sin(c.facing), c.position.y + 1.1,
                    c.position.z + Math.cos(c.facing)
                );
            };
            return p;
        };

        const me = mk("me", 0, 0);
        const players = new Map([["me", me]]);
        const world = {
            players, local: me, now: 0, deps: { terrain },
            spawn: (o) => { const p = mk(o.name, 0, 16); players.set(p.id, p); return p; },
            despawn: (id) => players.delete(id),
        };
        world.combat = new CombatResolver(world);
        world.spellFx = { castAs() {} };
        const crowd = new DummyCrowd(world, null);
        crowd.setCount(2);

        let closest = Infinity;
        let firstHit = -1;
        for (let i = 0; i < 60 * 20; i++) {
            world.now += dt;
            crowd.drive(dt, rig);
            for (const p of players.values()) p.update(dt, rig);
            world.combat.update(dt);
            world.combat.events.length = 0;
            for (const p of players.values()) {
                if (p === me) continue;
                closest = Math.min(closest, Vector3.Distance(p.controller.position, me.controller.position));
            }
            if (firstHit < 0 && me.health < 100) firstHit = i * dt;
            if (!me.alive) { me.alive = true; me.health = 100; }
        }
        ok(closest < 2.5, "they close to blade range, got " + closest.toFixed(2) + " m");
        ok(firstHit > 0, "and land a hit — first at " + (firstHit > 0 ? firstHit.toFixed(1) + " s" : "NEVER"));
    }

    // ---- do they cast, and is a visual asked for exactly when one succeeds? --
    {
        const me = mkPlayer("me", 0, 0);
        const players = new Map([["me", me]]);
        const world = {
            players, local: me, now: 0, deps: { terrain },
            spawn: (o) => { const p = mkPlayer(o.name, 0, 6); players.set(p.id, p); return p; },
            despawn: (id) => players.delete(id),
        };
        world.combat = new CombatResolver(world);
        const visuals = [];
        world.spellFx = { castAs: (id, owner, aim, at, trauma) => visuals.push({ id, trauma }) };
        const crowd = new DummyCrowd(world, null);
        crowd.setCount(3);

        const casts = [];
        /** Cast times per dummy, to check the rate limit rather than trust it. */
        const times = new Map();
        for (let i = 0; i < 60 * 120; i++) {
            world.now += dt;
            crowd.drive(dt, rig);
            world.combat.update(dt);
            for (const e of world.combat.events) {
                if (e.kind !== "cast") continue;
                casts.push(e.spell);
                if (!times.has(e.by)) times.set(e.by, []);
                times.get(e.by).push(world.now);
            }
            world.combat.events.length = 0;
            if (!me.alive) { me.alive = true; me.health = 100; me.effects.clearAll(); }
        }
        ok(casts.length > 0, "they cast at all, got " + casts.length + " casts");
        ok(new Set(casts).size >= 3, "using a variety, got " + new Set(casts).size + " distinct");
        ok(visuals.length === casts.length,
            `and every gameplay cast asks for a visual (${visuals.length} vs ${casts.length})`);
        ok(visuals.every((v) => v.trauma >= 0 && v.trauma <= 0.1), "with camera shake in range");

        // The rate limit. Honouring five separate 45 s cooldowns still let a dummy
        // empty its whole loadout in the first twelve seconds, which is spam by any
        // reasonable reading; the gap between one dummy's own casts is what fixes it.
        let worst = Infinity;
        for (const list of times.values()) {
            for (let i = 1; i < list.length; i++) worst = Math.min(worst, list[i] - list[i - 1]);
        }
        ok(times.size > 0 && [...times.values()].some((l) => l.length > 1),
            "at least one dummy cast more than once, so the gap is actually measured");
        ok(worst >= 10 - dt * 2,
            "no dummy casts twice inside 10 s, closest pair was " +
            (worst === Infinity ? "n/a" : worst.toFixed(2) + " s"));
    }

    return result();
}
