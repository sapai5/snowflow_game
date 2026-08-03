/** Melee: swept blades, damage per stage, one hit per swing, parry, death. */
import { CombatResolver } from "../src/game/combat.js";
import { suite, mkPlayer, mkWorld, aimBlade, STAGE } from "./harness.mjs";

const dt = 1 / 60;

export async function run() {
    const { ok, result } = suite();

    // ---- a live strike damages; a wind-up does not -------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        r.update(dt); // seeds the previous blade position

        a.combat.stage = 1;
        a.combat.stageTiming = STAGE;
        a.combat.t = 0.05; // still winding up
        aimBlade(a, 0, 1);
        r.update(dt);
        ok(b.health === 100, "the wind-up sweeps through a body harmlessly");

        a.combat.t = 0.2; // strike window
        aimBlade(a, 0, 1);
        r.update(dt);
        ok(b.health === 91, "a light hit takes 9, got " + b.health);
        ok(b.controller.velocity.length() > 0.1, "and shoves the victim");

        r.update(dt);
        ok(b.health === 91, "one swing lands once however long the blade overlaps");
    }

    // ---- the finisher hits harder ------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        r.update(dt);
        a.combat.stage = 3;
        a.combat.stageTiming = { windup: 0.24, strike: 0.34, recover: 0.3 };
        a.combat.t = 0.4;
        aimBlade(a, 0, 1);
        r.update(dt);
        ok(b.health === 85, "the finisher takes 15, got " + b.health);
    }

    // ---- parry by clash ----------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        r.update(dt);
        a.combat.stage = 1; a.combat.stageTiming = STAGE; a.combat.t = 0.2;
        b.combat.stage = 1; b.combat.stageTiming = STAGE; b.combat.t = 0.2;
        aimBlade(a, 0, 1);
        aimBlade(b, 0, 0);
        r.update(dt);
        ok(a.health === 100 && b.health === 100, "two live blades meeting do no damage");
        ok(a.effects.has("stagger") && b.effects.has("stagger"), "and stagger both");
        ok(a.sword.kicked && b.sword.kicked, "and ring both blades");
        ok(r.events.some((e) => e.kind === "clash"), "and report a clash");
    }

    // ---- death -------------------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        b.health = 8;
        r.damage(b, 9, "a", 0, null);
        ok(!b.alive && b.health === 0, "health floors at zero on death");
        ok(b.respawnAt === w.now + 4, "and a respawn is scheduled four seconds out");
        ok(r.events.some((e) => e.kind === "death" && e.by === "a"), "with the kill credited");
        r.damage(b, 20, "a", 0, null);
        ok(b.health === 0, "a corpse takes no further damage");
    }

    return result();
}

/**
 * The swept blade.
 *
 * The reason a static overlap test is not enough: at the velocity peak of a strike the
 * tip covers roughly 25 cm between frames, which is most of a body's width, so a blade
 * tested only where it sits on each frame boundary registers a hit or does not depending
 * on where in the arc the frame happened to fall.
 *
 * This suite exists because that is not a hypothetical — the sweep was disabled by an
 * aliasing bug for its whole life, and every other assertion in this file passed anyway.
 * The blade here is deliberately moved in one large step *across* a target it never
 * overlaps on either frame: the only way to detect that is the segment between them.
 */
export async function runSweep() {
    const { ok, result } = suite();
    const dt = 1 / 60;

    // ---- a blade that steps across a body still hits it -------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 2);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);

        a.combat.stage = 1; a.combat.stageTiming = STAGE; a.combat.t = 0.2;

        // Frame one: blade well to the left of the target, no overlap.
        aimBlade(a, -2.0, 2);
        r.update(dt);
        ok(!r.events.some((e) => e.kind === "hit"),
            "the first frame sweeps from nothing and cannot hit");

        // Frame two: blade well to the right. It was never *on* the target on either
        // frame — it went straight past it, and only the swept segment knows.
        r.events.length = 0;
        aimBlade(a, 2.0, 2);
        r.update(dt);
        ok(r.events.some((e) => e.kind === "hit"),
            "a blade that steps across a body registers the hit it clearly made");
    }

    // ---- the previous position survives the test --------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 9);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        aimBlade(a, -1, 0);
        r.update(dt);
        r.events.length = 0;
        aimBlade(a, 1, 0);
        r.update(dt);

        const rec = r._prevBlade.get("a");
        ok(rec !== undefined, "the blade's history is kept per player");
        // If prev and cur are the same objects, the segment has no length and the sweep
        // is decorative. This is the assertion that would have caught the original bug.
        ok(rec.guard !== rec.curGuard && rec.tip !== rec.curTip,
            "previous and current are separate vectors, so a sweep has length");
    }

    // ---- and it is carried forward, so sweeps are continuous --------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 9);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        aimBlade(a, 3, 0);
        r.update(dt);
        const rec = r._prevBlade.get("a");
        const firstTipX = rec.tip.x;
        r.events.length = 0;
        aimBlade(a, 5, 0);
        r.update(dt);
        ok(rec.tip.x !== firstTipX,
            "the committed position advances each frame rather than sticking");
        ok(Math.abs(rec.tip.x - 5) < 1e-6,
            "and it holds where the blade actually is, got " + rec.tip.x.toFixed(2));
    }

    // ---- a blade sweeping while not striking does no damage ---------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        a.combat.stage = 1; a.combat.stageTiming = STAGE;
        a.combat.t = 0.02; // still winding up
        aimBlade(a, -2, 1);
        r.update(dt);
        r.events.length = 0;
        aimBlade(a, 2, 1);
        r.update(dt);
        ok(!r.events.some((e) => e.kind === "hit"),
            "a sword being drawn back sweeps through people harmlessly");
        // But the position must still have been carried forward, or the first frame of
        // the strike would sweep from wherever the wind-up left the blade.
        const rec = r._prevBlade.get("a");
        ok(Math.abs(rec.tip.x - 2) < 1e-6,
            "while still tracking the blade, so the strike sweeps from the right place");
    }

    return result();
}
