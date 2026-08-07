/**
 * Combat feel — the fixes from docs/COMBAT_FEEL.md, held in place.
 *
 * Everything here is a regression test for a specific measured complaint: dead input
 * windows, phantom hitches on whiffs, and mud after swings. Each was individually
 * reasonable code whose numbers stopped being reasonable when the pacing changed around
 * it, which is exactly the kind of drift a suite is for.
 */
import { SwordCombat } from "../src/character/swordCombat.js";
import { CharacterController } from "../src/character/controller.js";
import { makeIntent } from "../src/game/intent.js";
import { suite } from "./harness.mjs";

const dt = 1 / 60;
const rig = {
    yaw: 0,
    addTrauma() {},
    getFlatForward: (o) => o.set(0, 0, 1),
    getFlatRight: (o) => o.set(1, 0, 0),
};

/** A character stub with every field the combo writes. */
function mkCh() {
    return {
        position: { x: 0, y: 0, z: 0 }, velocity: { x: 0, y: 0, z: 0 },
        facing: 0, airborne: false, hitstop: 0, moveScale: 1, surf: 0, intent: null,
        swingBlend: 0, swingArc: 0, swingPlane: 0, swingSet: 0, swingSnap: 0,
        swingRebase: 0, swingShift: 0, swingGrip: 0, swingBridge: 0,
        swingFromPlane: 0, swingFromArc: 0, swingStage: 0, swingMove: 1,
        attacking: false, slashHit: false, stompHit: false, slashStrength: 0,
        flinch: 0,
    };
}

const flat = {
    heightAt: () => 0,
    normalAt(x, z, out) { out.set(0, 1, 0); return out; },
    sampleAt: () => 0, slopeAt: () => 0, deform: () => {}, clampToPlayArea: () => {},
};

export async function run() {
    const { ok, result } = suite();

    // ---- clicks during the wind-up are buffered, not dropped ---------------
    {
        const ch = mkCh();
        const sc = new SwordCombat(ch);
        const it = makeIntent();

        // Start the string.
        it.attackPressed = true;
        sc.update(dt, rig, it);
        ok(sc.stage === 1, "the opener starts on the click");

        // One click in the middle of the wind-up — the window that used to eat inputs —
        // and then never again.
        it.attackPressed = false;
        while (sc.t < sc.stageTiming.windup * 0.5) sc.update(dt, rig, it);
        it.attackPressed = true;
        sc.update(dt, rig, it);
        it.attackPressed = false;
        ok(sc.queued === true,
            "a click during the wind-up is remembered — 0.93 s of the 2.89 s string " +
            "used to ignore the button");

        // Run out the attack with no further input: the buffered click must continue
        // the string on its own.
        let reached = 0;
        for (let f = 0; f < 300 && reached < 2; f++) {
            sc.update(dt, rig, it);
            if (sc.stage === 2) reached = 2;
        }
        ok(reached === 2,
            "and it continues the string with no second click, stage " + sc.stage);
    }

    // ---- a whiffed swing has no hit-stop in it -----------------------------
    {
        const ch = mkCh();
        const sc = new SwordCombat(ch);
        const it = makeIntent();
        it.attackPressed = true;
        sc.update(dt, rig, it);
        it.attackPressed = false;

        let worst = 0;
        for (let f = 0; f < 90; f++) {
            sc.update(dt, rig, it);
            worst = Math.max(worst, ch.hitstop);
        }
        ok(worst === 0,
            "a swing that hits nothing never slows time — the phase-timed hit-stop " +
            "gave every whiff a 45-75 ms hiccup indistinguishable from a dropped " +
            "frame, got " + worst.toFixed(3));
        // The terrain cut and camera kick still fire at the impact point; only the
        // time-stop is contact-gated now, and the resolver owns it (impact suite).
        ok(ch.slashHit === true, "while the blade still cuts the snow it swept through");
    }

    // ---- movement authority is shaped by phase, not flat -------------------
    {
        const ch = mkCh();
        const sc = new SwordCombat(ch);
        const it = makeIntent();
        it.attackPressed = true;
        sc.update(dt, rig, it);
        it.attackPressed = false;

        const byPhase = { windup: 1, strike: 1, recoverEnd: 0 };
        while (sc.stage === 1) {
            sc.update(dt, rig, it);
            const s = sc.stageTiming;
            if (!s) break;
            if (sc.t < s.windup) byPhase.windup = Math.min(byPhase.windup, ch.swingMove);
            else if (sc.t < s.windup + s.strike) byPhase.strike = Math.min(byPhase.strike, ch.swingMove);
            else byPhase.recoverEnd = Math.max(byPhase.recoverEnd, ch.swingMove);
        }
        ok(byPhase.windup >= 0.45,
            "the wind-up keeps half authority — it is where the attack is being " +
            "*placed*, got " + byPhase.windup.toFixed(2));
        ok(byPhase.strike <= 0.25,
            "the strike keeps the full lock — commitment is the point, and it is the " +
            "parry window, got " + byPhase.strike.toFixed(2));
        ok(byPhase.recoverEnd >= 0.7,
            "and footwork is mostly back by the end of the recovery, got " +
            byPhase.recoverEnd.toFixed(2));
        ok(ch.swingMove === 1, "with full authority restored once the attack ends");
    }

    // ---- the shaped authority actually reaches the legs --------------------
    {
        // The controller consumes swingMove weighted by swingBlend; a mid-strike player
        // must be far slower than a mid-recovery one.
        const speedAt = (move) => {
            const c = new CharacterController(flat);
            c.swingBlend = 1;
            c.swingMove = move;
            const it = makeIntent();
            it.moveZ = 1;
            it.sprint = true;
            for (let f = 0; f < 120; f++) c.update(dt, rig, it);
            return Math.hypot(c.velocity.x, c.velocity.z);
        };
        const struck = speedAt(0.2);
        const recovering = speedAt(0.8);
        const free = speedAt(1.0);
        ok(struck < free * 0.3,
            "mid-strike is a fifth of full speed, got " + struck.toFixed(2) + " of " +
            free.toFixed(2));
        ok(recovering > free * 0.7,
            "late recovery is most of it, got " + recovering.toFixed(2));
    }

    // ---- the pose blend releases fast enough not to be a third lock --------
    {
        const ch = mkCh();
        const sc = new SwordCombat(ch);
        const it = makeIntent();
        it.attackPressed = true;
        sc.update(dt, rig, it);
        it.attackPressed = false;
        while (sc.stage !== 0) sc.update(dt, rig, it);

        // From wherever the blend stands when the attack ends, it should be nearly
        // gone within a tenth of a second.
        const start = ch.swingBlend;
        for (let f = 0; f < 9; f++) sc.update(dt, rig, it);
        ok(ch.swingBlend < start * 0.3,
            "the blend releases within ~0.15 s of the attack ending rather than " +
            "lingering as a third layer of slowdown: " + start.toFixed(2) + " -> " +
            ch.swingBlend.toFixed(2));
    }

    return result();
}

/**
 * Soft aim tracking, and the body's reaction to being hit.
 *
 * The P1/P2 half of docs/COMBAT_FEEL.md. Both exist for the same underlying reason: the
 * pacing changes were correct and left two gaps around themselves — long wind-ups that
 * aimed at nothing in particular, and a half-second input lock on a figure that showed no
 * sign of being locked.
 */
export async function runTracking() {
    const { ok, result } = suite();

    /** A stationary opponent at (x, z). */
    const foeAt = (x, z) => ({ controller: { position: { x, y: 0, z } }, alive: true });

    /**
     * Swing once with a target present and report the facing at the end of the wind-up.
     *
     * `aimYaw` is what the player actually pointed; the return is where the body ended up.
     */
    function windupFacing(foe, aimYaw) {
        const ch = mkCh();
        const sc = new SwordCombat(ch);
        sc.findTarget = () => foe;
        const it = makeIntent();
        it.aimYaw = aimYaw;
        it.attackPressed = true;
        sc.update(dt, rig, it);
        it.attackPressed = false;
        while (sc.stage === 1 && sc.t < sc.stageTiming.windup) sc.update(dt, rig, it);
        return ch.facing;
    }

    const bearingTo = (x, z) => Math.atan2(x, z);
    const near = (a, b, tol) => Math.abs(a - b) < tol;

    // ---- an attack turns onto a target that has strafed off the aim line ----
    {
        // The player aims straight ahead; the opponent has slid 1.2 m to the right at
        // 3 m out — 22 degrees off, inside the cone.
        const foe = foeAt(1.2, 3);
        const facing = windupFacing(foe, 0);
        const bearing = bearingTo(1.2, 3);
        ok(facing > 0.1,
            "the wind-up turns toward a strafing target rather than holding the aim " +
            "line, facing " + facing.toFixed(2) + " rad");
        ok(near(facing, bearing, 0.12),
            "and arrives close to their actual bearing, " + facing.toFixed(2) +
            " against " + bearing.toFixed(2));
    }

    // ---- but never further than the cone allows ---------------------------
    {
        // Same distance, far off the aim line: 60 degrees, outside the 35 degree cone.
        const x = 3 * Math.tan(1.05);
        const foe = foeAt(x, 3);
        const facing = windupFacing(foe, 0);
        ok(Math.abs(facing) < 0.1,
            "a target outside the cone is ignored, so the attack goes where it was " +
            "aimed: facing " + facing.toFixed(3) + " rad");
    }

    // ---- and not across the map -------------------------------------------
    {
        // Straight down the aim line but well beyond tracking range.
        const foe = foeAt(0.9, 9);
        const facing = windupFacing(foe, 0);
        ok(Math.abs(facing) < 0.1,
            "a target beyond range is ignored, facing " + facing.toFixed(3) + " rad");
    }

    // ---- no target, no change --------------------------------------------
    {
        const facing = windupFacing(null, 0.4);
        ok(near(facing, 0.4, 0.05),
            "with nobody to track, the attack faces exactly where it was aimed, " +
            facing.toFixed(2));
    }

    // ---- the strike does not track ---------------------------------------
    {
        // Tracking during the active frames would make spacing meaningless and break the
        // parry geometry. The target is moved *after* the wind-up ends, and the facing
        // must not follow it.
        const ch = mkCh();
        const sc = new SwordCombat(ch);
        const foe = foeAt(0.6, 3);
        sc.findTarget = () => foe;
        const it = makeIntent();
        it.aimYaw = 0;
        it.attackPressed = true;
        sc.update(dt, rig, it);
        it.attackPressed = false;
        while (sc.t < sc.stageTiming.windup) sc.update(dt, rig, it);
        const atRelease = ch.facing;

        // They dodge hard to the other side, still inside the cone and range.
        foe.controller.position.x = -1.2;
        while (sc.t < sc.stageTiming.windup + sc.stageTiming.strike) sc.update(dt, rig, it);
        ok(near(ch.facing, atRelease, 0.03),
            "the strike holds the direction the wind-up committed to — side-stepping a " +
            "swung attack works, and the swept blade stays honest: " +
            atRelease.toFixed(3) + " -> " + ch.facing.toFixed(3));
    }

    // ---- the world supplies the target, excluding remotes ----------------
    {
        const src = (await import("node:fs")).readFileSync(
            new URL("../src/game/world.js", import.meta.url), "utf8"
        );
        ok(/findTarget = \(\) => \(p\.remote \? null : this\._nearestFoe\(p\)\)/.test(src),
            "remote players do not track locally — their facing comes off the wire, and " +
            "a locally-chosen goal would fight it every frame");
        ok(/if \(q === self \|\| !q\.alive\) continue/.test(src),
            "and corpses are not targets");
    }

    return result();
}

/**
 * The flinch.
 */
export async function runFlinch() {
    const { ok, result } = suite();

    const { CombatResolver } = await import("../src/game/combat.js");
    const { mkPlayer, mkWorld, aimBlade, STAGE } = await import("./harness.mjs");
    const { FINISHER_STAGGER } = await import("../src/game/rules.js");

    /** Land a stage-`n` hit from a on b and hand back both. */
    function strike(n) {
        const a = mkPlayer("a", 0, 0);
        const b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        r.update(dt);
        a.combat.stage = n;
        a.combat.stageTiming = STAGE;
        a.combat.t = 0.2;
        aimBlade(a, 0, 1);
        r.update(dt);
        return { a, b, r };
    }

    // ---- a light hit moves the body --------------------------------------
    {
        const { b } = strike(1);
        ok(b.controller.flinch > 0.2,
            "a light hit flinches the victim — every other cue was *around* the body, " +
            "so two players trading jabs read as mannequins swapping particles: got " +
            b.controller.flinch.toFixed(2));
    }

    // ---- the finisher moves it further ------------------------------------
    {
        const light = strike(1).b.controller.flinch;
        const heavy = strike(3).b.controller.flinch;
        ok(heavy > light,
            "and the finisher harder than a light stroke, " + heavy.toFixed(2) +
            " against " + light.toFixed(2));
    }

    // ---- a clash flinches both ------------------------------------------
    {
        const a = mkPlayer("a", 0, 0);
        const b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        r.update(dt);
        for (const p of [a, b]) {
            p.combat.stage = 1;
            p.combat.stageTiming = STAGE;
            p.combat.t = 0.2;
        }
        aimBlade(a, 0, 1);
        aimBlade(b, 0, 0);
        r.update(dt);
        ok(a.controller.flinch > 0.5 && b.controller.flinch > 0.5,
            "a clash flinches both fighters: the stagger is a half-second input lock, " +
            "and a lock on an idle pose is the same picture as the game hanging");
    }

    // ---- a burn tick does not ---------------------------------------------
    {
        const { DOT } = await import("../src/game/rules.js");
        const a = mkPlayer("a", 0, 0);
        const b = mkPlayer("b", 0, 1);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        b.effects.apply(DOT, 6, 2, "a");
        for (let f = 0; f < 30; f++) r.update(dt);
        ok(b.controller.flinch === 0,
            "standing in a crystal field does not flinch six times a second — that is a " +
            "seizure, not a reaction: got " + b.controller.flinch.toFixed(2));
    }

    // ---- it decays, and the figure reads it -----------------------------
    {
        const { b } = strike(3);
        const start = b.controller.flinch;
        const { CharacterController } = await import("../src/character/controller.js");
        const c = new CharacterController(flat);
        c.flinch = start;
        const it = makeIntent();
        for (let f = 0; f < 30; f++) c.update(dt, rig, it);
        ok(c.flinch < start * 0.4,
            "a flinch is over within half a second, " + start.toFixed(2) + " -> " +
            c.flinch.toFixed(2));
        ok(c.flinch >= 0, "and never goes negative");

        const fig = (await import("node:fs")).readFileSync(
            new URL("../src/character/figure.js", import.meta.url), "utf8"
        );
        ok(/ch\.flinch \* ch\.flinch/.test(fig),
            "the figure hunches and dips by the square of it, so the onset is sharp " +
            "and the tail is gentle");
    }

    // ---- casting is gated while swinging ---------------------------------
    {
        const a = mkPlayer("a", 0, 0);
        const b = mkPlayer("b", 0, 6);
        const w = mkWorld([a, b]);
        const r = new CombatResolver(w);
        w.combat = r;
        const origin = { x: 0, y: 1, z: 0 };
        const aim = { x: 0, y: 0, z: 1 };

        a.combat.stage = 1;
        ok(r.cast(a, 1, origin, aim) === false,
            "no casting mid-swing: the gesture and the sword want the same arm");
        a.combat.stage = 0;
        ok(r.cast(a, 1, origin, aim) === true, "and it works again once the swing ends");

        // A relayed cast skips the gate: the caster's client already ruled, and this
        // client's view of their swing may be a snapshot behind.
        const c = mkPlayer("c", 3, 3);
        w.players.set("c", c);
        c.combat.stage = 2;
        ok(r.cast(c, 3, origin, aim, true) === true,
            "a relayed cast is not second-guessed on someone else's swing state");
    }

    return result();
}
