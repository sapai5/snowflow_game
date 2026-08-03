/** The five spells: shape, consequence, cooldown, and who they are allowed to hit. */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CombatResolver, SPELL_COOLDOWN } from "../src/game/combat.js";
import { suite, mkPlayer, mkWorld, terrain, STAGE } from "./harness.mjs";

const dt = 1 / 60;
const fwd = new Vector3(0, 0, 1);
const step = (w, r, n) => { for (let i = 0; i < n; i++) { w.now += dt; r.update(dt); w.combat = r; } };

export async function run() {
    const { ok, result } = suite();
    const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;

    // 1 Wave -----------------------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 4), c = mkPlayer("c", 0, -4);
        const w = mkWorld([a, b, c]); const r = new CombatResolver(w);
        r.cast(a, 1, a.controller.position.clone(), fwd);
        step(w, r, 3);
        ok(b.health === 90, "Wave takes 10 in front, got " + b.health);
        ok(c.health === 100, "and nothing behind the caster");
        ok(near(b.effects.strength("slow"), 0.4), "it slows 40%");
        ok(near(b.effects.remaining("slow"), 3, 0.1), "for three seconds");
        ok(b.controller.velocity.length() > 5, "and shoves hard");
        ok(a.cooldowns[0] >= SPELL_COOLDOWN, "and starts a 45 s cooldown");
    }

    // 2 Snowball -------------------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 8);
        const w = mkWorld([a, b]); const r = new CombatResolver(w);
        r.cast(a, 2, new Vector3(0, 1.4, 0), fwd);
        step(w, r, 30);
        ok(b.health === 85, "Snowball takes 15, got " + b.health);
        ok(near(b.effects.remaining("blind"), 1.2, 0.2), "and blinds for 1.2 s");

        // A live blade must not stop it.
        const c = mkPlayer("c", 0, 0), d = mkPlayer("d", 0, 6);
        const w2 = mkWorld([c, d]); const r2 = new CombatResolver(w2);
        d.combat.stage = 1; d.combat.stageTiming = { windup: 0.1, strike: 0.5, recover: 0.1 };
        d.combat.t = 0.2; d.controller.facing = Math.PI;
        r2.cast(c, 2, new Vector3(0, 1.4, 0), fwd);
        step(w2, r2, 30);
        ok(d.health === 85, "and is unblockable even mid-swing, got " + d.health);
    }

    // 3 Updraft --------------------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 2);
        const w = mkWorld([a, b]); const r = new CombatResolver(w);
        r.cast(a, 3, new Vector3(0, 0, 1), fwd);
        step(w, r, 3);
        ok(b.controller.velocityY > 6 && b.controller.airborne, "Updraft launches the target");
        ok(a.controller.velocityY > 6, "and the caster if they stand in it");
        ok(near(b.effects.strength("airRestrict"), 0.75), "restricting movement 75%");
        ok(b.health === 92, "and taking 8, got " + b.health);
    }

    // 4 Crystal field --------------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 2);
        const w = mkWorld([a, b]); const r = new CombatResolver(w);
        r.cast(a, 4, new Vector3(0, 0, 2), fwd);
        step(w, r, 3);
        ok(b.health === 80, "the eruption takes 20, got " + b.health);
        step(w, r, 120);
        const burned = 80 - b.health;
        // The impact must not re-apply with the burn: doing so paid 80 a second out
        // of a spell specced at six.
        ok(burned >= 8 && burned <= 16, "then burns about 6/s, took " + burned + " over 2 s");
        b.controller.position.set(0, 0, 40);
        const at = b.health;
        step(w, r, 90);
        ok(b.health >= at - 4, "and stops when you leave it");
    }

    // 5 Vortex ---------------------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 2);
        const w = mkWorld([a, b]); const r = new CombatResolver(w);
        r.cast(a, 5, a.controller.position.clone(), fwd);
        step(w, r, 3);
        ok(b.health === 100, "Vortex does no damage");
        // Knockback used to live inside damage(), so a zero-damage spell shoved nobody.
        ok(b.controller.velocity.length() > 8, "but shoves hard, got " + b.controller.velocity.length().toFixed(1));

        const c = mkPlayer("c", 0, 0), d = mkPlayer("d", 0, 5);
        const w2 = mkWorld([c, d]); const r2 = new CombatResolver(w2);
        r2.cast(d, 2, new Vector3(0, 1.4, 5), new Vector3(0, 0, -1));
        r2.cast(c, 5, c.controller.position.clone(), fwd);
        step(w2, r2, 25);
        ok(c.health === 85, "and does not deflect a Snowball, got " + c.health);
    }

    // cooldowns and gating ---------------------------------------------------
    {
        const a = mkPlayer("a", 0, 0), b = mkPlayer("b", 0, 3);
        const w = mkWorld([a, b]); const r = new CombatResolver(w);
        ok(r.cast(a, 1, a.controller.position.clone(), fwd), "the first cast is allowed");
        ok(!r.cast(a, 1, a.controller.position.clone(), fwd), "a second is refused");
        w.now += SPELL_COOLDOWN + 0.1;
        ok(r.cast(a, 1, a.controller.position.clone(), fwd), "and allowed again after 45 s");

        const c = mkPlayer("c", 0, 0);
        const w2 = mkWorld([c]); const r2 = new CombatResolver(w2);
        c.effects.apply(3, 1, 0.5);
        ok(!r2.cast(c, 1, c.controller.position.clone(), fwd), "a staggered player cannot cast");
        c.effects.clearAll();
        c.alive = false;
        ok(!r2.cast(c, 1, c.controller.position.clone(), fwd), "nor can a dead one");
    }

    return result();
}
