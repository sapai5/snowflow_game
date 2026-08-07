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
