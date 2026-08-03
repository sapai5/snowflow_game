/**
 * The sword combo: two light strokes that cross, then a heavy finisher.
 *
 * Three attacks in a fixed escalating string, and no plane is ever repeated:
 *
 *   1  Quick Slash. A tight diagonal, high-left to low-right. The wind-up barely
 *      passes the hip, the hips and torso turn almost together, and the weight
 *      shifts forward without committing. A jab.
 *
 *   2  Return Slash. The mirror stroke: the blade is already low-right where the
 *      first slash left it, and the second click cuts *back* along the opposite
 *      diagonal, low-right to high-left. Slightly wider, slightly more body than
 *      the first — the string is escalating — but still light. Chained, its
 *      wind-up is nearly free: the follow-through of the first stroke *is* its
 *      coil.
 *
 *   3  Heavy Finisher. The blade is now high-left; the third click coils it a
 *      fraction further and unloads the big descending cross-body cut, high-left
 *      to past the right hip, with the hitch, the stomp, the hit-stop and the
 *      held overrotated finish. The highest commitment arc in the string, on the
 *      diagonal neither light stroke used.
 *
 * The escalation and the alternation are the whole design: click once and it is a
 * jab; keep clicking and the string cycles right, left, heavy — never the same
 * sweep twice in a row, with each stroke's follow-through feeding the next one's
 * coil.
 *
 * It owns nothing but timing and intent — the pose is the figure's, the blade is
 * the sword's, and the marks in the snow are the contact system's. What it writes
 * is the same kind of state the spell system writes: blend weights and a phase on
 * the controller, which everything downstream reads.
 *
 * ---------------------------------------------------------------------------
 * What to tune, and where
 * ---------------------------------------------------------------------------
 *
 *   speed        `STAGES` — every phase duration, in seconds, per attack.
 *   arc geometry `SWING_ARCS` in `figure.js` — two angles per end of each sweep,
 *                in degrees, for both the sword hand and the off hand.
 *   arc timing   `STRIKE_POWER` here.
 *   escalation   `snap` and `set` per stage: hip/torso separation and stance.
 *   commitment   `drive` and `stomp` per stage, plus the movement lock in
 *                `CharacterController._walkStep`.
 *   body lag     the spring constants in `figure.js`; blade lag, `WHIP_*` in
 *                `sword.js`.
 *
 * ---------------------------------------------------------------------------
 * State
 * ---------------------------------------------------------------------------
 *
 * One attack runs at a time and it always runs to completion — `isAttacking` is
 * the whole state machine. An attack cannot be interrupted, restarted or blended
 * over by another click; a click that arrives during one is *buffered* into a
 * single flag, and the buffer may only open the next attack when the current one
 * reaches its recovery or ends. A mashed button can never break a swing mid-arc.
 *
 * Clicks during the wind-up are dropped rather than buffered. Before the strike has
 * released, "again" is not yet a meaningful instruction, and honouring it turns a
 * double-click into an attack the player never saw start.
 *
 * Allocation per frame: none.
 */

import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { expDamp } from "../core/camera.js";
import { angleDamp } from "./controller.js";

/**
 * Every phase of every attack, in seconds, plus what each attack commits.
 *
 * A zero-length phase is skipped entirely, which is how the two attacks get
 * genuinely different shapes out of one curve:
 *
 *   hold    the hitch at the top of the coil. The Quick Slash has none — a pause
 *           in a jab reads as the animation stalling — and the finisher has a tenth
 *           of a second of it, which is what makes the unload land as a decision.
 *   finish  holding the overrotated end pose. Again none for the jab, which has to
 *           be ready to chain, and a sixth of a second for the finisher, where the
 *           pose *is* the payoff.
 *
 * The other per-stage numbers:
 *
 *   drive   forward impulse at the release, m/s. The finisher's is a lunge.
 *   snap    how much of the hip/torso separation to remove, 0..1. High for the
 *           jab: a quick slash turns almost as one piece, and the lag chain that
 *           makes a heavy swing read as a whip makes a fast one read as loose.
 *   set     how planted the stance gets, 0..1. The jab shifts weight; it does not
 *           plant.
 *   stomp   weight of the front-foot impact. Scales the print, the powder and the
 *           camera.
 *   trauma  camera kick at the impact. The release gets 40% of it.
 */
const STAGES = [
    {
        // The strike used to be 0.19 s. At 60 fps that is eleven frames for 123
        // degrees of hand travel, and at the velocity peak the arm moved 17 degrees
        // between frames — at 30 fps, 35. That is not a fast swing, it is an
        // undersampled one: the pose is correct on every frame and the eye is given
        // nothing to join them with, which is what reads as choppy. The blade's own
        // trail is subdivided and stays smooth, which is why the *arm* was the part
        // that looked wrong.
        //
        // 0.28 s with the shorter arc holds the peak under 18 degrees a frame at 30 fps
        // and under 9 at 60.
        windup: 0.15, strike: 0.28, recover: 0.17,
        drive: 1.7, plane: 1, snap: 0.65, set: 0.45, stomp: 0.3, trauma: 0.10,
        // Overshoot past the target line, in units of half the sweep. The jab's
        // arc is 101 degrees, so 0.70 half-sweeps is ~35 degrees of blade travel
        // past centre before it catches itself.
        followThrough: 0.70,
        // Slow-motion at contact, and its length. Not a freeze — see `HITSTOP_RATE`.
        hitstop: 0.045,
    },
    {
        // The return stroke. Chained, most of this wind-up never plays — the
        // rebase puts the blade at the coil already and the body just re-orients.
        // A touch wider and heavier than the first: the string is escalating.
        windup: 0.17, strike: 0.32, recover: 0.18,
        drive: 2.2, plane: 3, snap: 0.50, set: 0.55, stomp: 0.45, trauma: 0.13,
        followThrough: 0.62,
        hitstop: 0.05,
    },
    {
        // The finisher's anticipation is a *long slow coil*, not a hitch. It used
        // to hold the blade still at the top for a sixth of a second and hold the
        // end pose for another sixth, and between them the blade was stationary
        // for 420 ms of a 1.26 s attack. Anticipation that stops reads as a
        // dropped frame; anticipation that keeps travelling reads as weight.
        //
        // The recovery is shorter than the wind-up on purpose. A long recovery on a
        // small overshoot gives the follow-through a slow apex, which is a stop by
        // another name; a brisk one carries the blade over the top and back.
        windup: 0.38, strike: 0.44, recover: 0.30,
        drive: 8.5, plane: 2, snap: 0.0, set: 1.0, stomp: 1.0, trauma: 0.30,
        // ~31 degrees past the end of the descending arc, in the same half-sweep units.
        // The cut is vertical now and it ends below the belt, so the overshoot carries the
        // hand down and slightly across rather than around the side — a right hand that has
        // finished a vertical cut has run out of shoulder, not out of momentum, and the
        // envelope clamp catches it if this is ever raised too far.
        followThrough: 0.51,
        hitstop: 0.075,
    },
];

/** How long after a stroke ends a click still continues the string. */
const CHAIN_WINDOW = 0.50;

/**
 * The strike's velocity profile: `smoothstep(u)^1.8`, mixed with a linear ramp.
 *
 * The exponent is chosen for where it puts the *fastest* moment of the swing:
 * peak angular velocity lands around two thirds of the way through the arc, just
 * before the blade would cross dead centre, which is what makes a swing read as a
 * snap rather than as a constant-speed sweep.
 *
 * `STRIKE_FLOOR` is the fix for the swing appearing to stop. A pure
 * `smoothstep^1.8` has *zero* derivative at both ends: it leaves the coil at a
 * standstill and arrives at the finish at a standstill, and with a wind-up that
 * also arrives slowly the blade spent a quarter of a second barely moving at each
 * reversal. Mixing in a linear term gives the curve a velocity floor — it departs
 * with speed, it arrives with speed, and the recovery picks that speed up — so the
 * only instants of zero velocity left in the whole attack are the two genuine
 * changes of direction, each one frame long.
 */
/*
 * Softened from 1.8 / 0.24.
 *
 * The exponent is what concentrates the travel into the middle of the strike, and at 1.8
 * it put a 1.6:1 ratio between the peak frame and the average one. That ratio is the
 * point of the curve — a swing should snap — but it is also multiplied by however few
 * frames the strike lasts, and the two together were what made the fast attacks look like
 * they skipped. Lengthening the strike and flattening the peak share the work; either
 * alone would have had to be taken too far.
 */
const STRIKE_POWER = 1.45;
const STRIKE_FLOOR = 0.34;

/**
 * How fast the wind-up loads, as an exponent on its own curve.
 *
 * Above 1 it *accelerates* into the coil, which is deliberate and is the other
 * half of the no-stop fix: a wind-up that decelerates into the reversal and a
 * strike that accelerates out of one puts two slow phases back to back. Arriving
 * at the coil quickly and leaving it quickly makes the reversal an instant instead
 * of a pause, which is what a real backswing does — it whips around.
 */
const WINDUP_POWER = 1.7;

/**
 * Time scale during the hit-stop. Slow motion, not a freeze.
 *
 * At 0.05 this was a hard stop of one to three frames, and however good that is on
 * a fighting-game hit it is still the blade stopping mid-swing. A third of speed
 * for twice as long delivers the same "that connected" beat while every joint in
 * the chain keeps travelling.
 */
const HITSTOP_RATE = 0.35;

/**
 * Where in the strike each attack's edge crosses the target line — solved from the
 * curve for a finish at 1.0 with the stage's own overshoot past it. The cut, the
 * hit-stop and the camera kick all fire here, which with this curve is right at
 * the velocity peak's far shoulder: the blade is at its fastest as it connects.
 */
const IMPACT_AT = STAGES.map((s) => {
    // The sweep runs arc = -1 + (2 + ft)·curve(u); it crosses the target line
    // (arc = 1) when curve reaches 2/(2 + ft).
    const target = 2 / (2 + s.followThrough);
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 50; i++) {
        const m = (lo + hi) / 2;
        if (strikeCurve(m) < target) lo = m;
        else hi = m;
    }
    return (lo + hi) / 2;
});

export class SwordCombat {
    /**
     * @param {import("./controller.js").CharacterController} character
     */
    constructor(character) {
        this.ch = character;

        /** 0 = idle, else 1..2 — which attack is playing. */
        this.stage = 0;
        /** Seconds into the current stage. */
        this.t = 0;
        /** Last stage that completed, for chaining. */
        this.lastStage = 0;
        /** A click arrived mid-attack and is waiting for it to finish. */
        this.queued = false;
        /** Time left in the chain window. */
        this.chain = 0;
        /** Arc value this attack's wind-up started from. -1 when chained. */
        this._startArc = 0;
    }

    /** True from the frame an attack begins to the frame it ends. */
    get isAttacking() {
        return this.stage > 0;
    }

    /**
     * The phase durations of the attack currently playing, or null.
     *
     * Exposed for the hit resolver, which needs to know when the blade is *live*:
     * the strike phase does damage and the wind-up and the recovery move the blade
     * through people harmlessly. Handing out the table rather than a boolean keeps
     * the definition of "live" in the resolver, where the rest of the combat rules
     * are, instead of splitting it across two files.
     */
    get stageTiming() {
        return this.stage > 0 ? STAGES[this.stage - 1] : null;
    }

    /**
     * Stop the attack where it is.
     *
     * Called when the swing is parried or the swinger is killed. The pose eases out
     * from wherever it had reached rather than snapping to guard — the blend is a
     * spring chain and letting it settle is both cheaper and better looking than
     * resetting it.
     */
    interrupt() {
        this.stage = 0;
        this.t = 0;
        this.queued = false;
        this.chain = 0;
        this.lastStage = 0;
        this.ch.attacking = false;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {{attackPressed: boolean}} [intent] what this character is being told
     *   to do; the controller holds the same object.
     */
    update(dt, rig, intent) {
        const ch = this.ch;
        const h = Math.min(dt, 1 / 30);
        const input = intent || ch.intent || { attackPressed: false };

        // No swordplay off the board's back. Surfing already owns the right mouse
        // button, both arms and the whole upper body pose, and a slash blended
        // into a carve reads as neither.
        const allowed = ch.surf < 0.5;
        if (!allowed && this.stage > 0) this._cancel();

        if (input.attackPressed && allowed) {
            if (this.stage === 0) {
                this._begin(this._nextStage());
            } else if (this.t >= STAGES[this.stage - 1].windup) {
                this.queued = true;
            }
        }

        if (this.stage > 0) {
            const s = STAGES[this.stage - 1];
            const total = s.windup + s.strike + s.recover;
            const prev = this.t;

            // Hit-stop: the phase clock *slows* at contact — it does not stop. The
            // figure's springs and the blade's whip take the same scale off the same
            // flag, so the whole chain drops into slow motion together and every
            // joint keeps travelling. See `HITSTOP_RATE`.
            this.t += h * (ch.hitstop > 0 ? HITSTOP_RATE : 1);

            // Turn to face where the player is looking, and do it during the coil
            // rather than at the strike. You attack where you are aiming — an
            // attack that fires off the direction the feet happened to be pointing
            // feels unresponsive without ever being identifiable as a bug.
            if (this.t < s.windup) {
                // Where the *attacker* is aiming, not where the camera is looking. For
                // the local player those are the same thing and `aimYaw` is null; for
                // anyone else the camera belongs to somebody on the other side of the
                // fight, and turning to face it was making every NPC swing at whatever
                // the human happened to be looking at.
                const aim = input.aimYaw === null || input.aimYaw === undefined
                    ? rig.yaw
                    : input.aimYaw;
                ch.facing = angleDamp(ch.facing, aim, 16, h);
            }

            // The legs go at the start of the uncoil; the edge arrives near the end
            // of it. Two events, in the order a body does them.
            const release = s.windup;
            const impact = release + s.strike * IMPACT_AT[this.stage - 1];
            if (prev < release && this.t >= release) this._release(s, rig);
            if (prev < impact && this.t >= impact) this._impact(s, rig);

            // A buffered click cancels the recovery. The recovery exists so a
            // single hit finishes grounded; it should not also be a queue the
            // player waits behind.
            //
            // The next stage is taken from the one running, *not* from
            // `_nextStage()`: that helper gates on the chain window, which is only
            // open between attacks and is therefore always shut here. Routing this
            // path through it restarted the string at the opener every time, so
            // mashing the button replayed the first slash instead of advancing —
            // which is precisely the "just spamming one move" this string was built
            // to fix.
            if (this.queued && allowed && this.t >= total - s.recover) {
                const next = this.stage < STAGES.length ? this.stage + 1 : 1;
                this.lastStage = this.stage;
                this.queued = false;
                this._begin(next);
                this._publish(h, allowed);
                return;
            }

            if (this.t >= total) {
                this.lastStage = this.stage;
                this.stage = 0;
                this.t = 0;
                this.chain = CHAIN_WINDOW;
                ch.attacking = false;
                if (this.queued && allowed) {
                    this.queued = false;
                    this._begin(this._nextStage());
                } else {
                    this.queued = false;
                }
            }
        } else {
            this.chain = Math.max(0, this.chain - h);
            if (this.chain === 0) this.lastStage = 0;
            this.queued = false;
        }

        this._publish(h, allowed);
    }

    /**
     * Which attack a click starts: the next stroke of the string, or the opener.
     *
     * The return stroke and the finisher are only reachable as continuations.
     * Either from a standing start would hand the player a committed swing whose
     * whole shape assumes momentum they have not built.
     */
    _nextStage() {
        if (this.chain > 0 && this.lastStage >= 1 && this.lastStage < 3) {
            return this.lastStage + 1;
        }
        return 1;
    }

    _begin(stage) {
        // Chaining redirects the previous stroke's leftover momentum rather than
        // rewinding it. The arcs are designed end-to-start down the whole string —
        // each stroke's follow-through leaves the blade where the next one coils —
        // so the phase is rebased: "past the end of that swing" becomes "at the
        // coil of this one", same world direction, new plane. The figure's springs
        // shift by the same amount through `swingRebase`, and their *velocities*
        // are deliberately left alone: whatever angular rate the follow-through
        // still carried arrives in the new wind-up as the slingshot.
        //
        // `_startArc` then tells the wind-up curve where it is starting from: a
        // chained wind-up holds the coil (the body re-orients around a blade that
        // is already back); a cold one draws the blade back from guard.
        if (stage > 1 && this.lastStage >= 1) {
            const shift = 2 + STAGES[this.lastStage - 1].followThrough;
            this.ch.swingArc -= shift;
            this.ch.swingRebase -= shift;
            this._startArc = -1;
        } else {
            this._startArc = 0;
        }
        this.stage = stage;
        this.t = 0;
        this.chain = 0;
        this.ch.attacking = true;
    }

    /** Drop the current attack. Only surfing does this. */
    _cancel() {
        this.stage = 0;
        this.t = 0;
        this.chain = 0;
        this.queued = false;
        this.ch.attacking = false;
    }

    /**
     * The uncoil releases: the legs go, and the front foot takes it.
     */
    _release(s, rig) {
        const ch = this.ch;
        // Drive along the facing, as an impulse rather than a scripted slide, so
        // the ground friction and the terrain both still get a say. The walk step
        // pulls it back down over about a third of a second, which for the
        // finisher's lunge is a metre and a half of travel.
        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        // Airborne there is nothing to push off, so the drive is mostly gone — an
        // air slash should not be a flight.
        const grounded = ch.airborne ? 0.35 : 1;
        ch.velocity.x += fx * s.drive * grounded;
        ch.velocity.z += fz * s.drive * grounded;

        ch.slashStrength = s.stomp;
        if (s.stomp > 0.2) ch.stompHit = true;
        rig.addTrauma(s.trauma * 0.4 + s.stomp * 0.06);
    }

    /**
     * The blade arrives. This is the frame the edge is at full extension, and it is
     * where the cut, the powder off it and the bulk of the camera kick belong.
     */
    _impact(s, rig) {
        this.ch.slashHit = true;
        this.ch.hitstop = s.hitstop;
        rig.addTrauma(s.trauma);
    }

    /**
     * Write the pose state the figure and the blade read.
     *
     * Four channels, and the split is what lets the figure stay ignorant of the
     * timing:
     *
     *   swingArc    the sweep. Eases into the coil, holds it if this attack has a
     *               hitch, accelerates hard out of it, decelerates into the finish
     *               past the target line, holds the end pose if this attack has
     *               one, and returns to guard.
     *   swingSet    how planted the stance is. Rises with the coil, holds through
     *               the strike, releases late — so an attack finishes low and
     *               grounded rather than standing up out of its own follow-through.
     *   swingShift  where the weight is, -1 fully on the back leg through +1 driven
     *               onto the front foot. It moves early in the strike, so the drive
     *               precedes the blade instead of following it.
     *   swingSnap   how much hip/torso separation to remove. The jab turns nearly
     *               as one piece; the finisher separates fully.
     */
    _publish(h, allowed) {
        const ch = this.ch;

        let arc = 0;
        let want = 0;
        let set = 0;
        let shift = 0;
        let snap = 0;

        if (this.stage > 0) {
            const s = STAGES[this.stage - 1];
            const ft = s.followThrough;
            const t = this.t;
            want = 1;
            snap = s.snap;

            const tStrike = s.windup;
            const tRecover = tStrike + s.strike;

            if (t < tStrike) {
                const u = t / s.windup;
                // Accelerating into the coil — see `WINDUP_POWER`. It leaves guard
                // gently and arrives at the coil already travelling, so the reversal
                // into the strike is an instant rather than a rest. From guard that
                // is a full draw; chained, `_startArc` is already the coil and this
                // barely moves while the body re-orients into the new plane.
                const w = Math.pow(u, WINDUP_POWER);
                arc = this._startArc + (-1 - this._startArc) * w;
                set = easeOutCubic(u);
                shift = -easeOutCubic(u);
            } else if (t < tRecover) {
                const u = (t - tStrike) / s.strike;
                // The uncoil and the overshoot in one curve: leaves the coil already
                // moving, fastest around two thirds, through the target line at the
                // far shoulder of the peak, and *still travelling* as it passes into
                // the overrotated finish. See `STRIKE_POWER` and `STRIKE_FLOOR`.
                arc = -1 + (2 + ft) * strikeCurve(u);
                set = 1;
                // The legs go first and they go fast — quadratic out, scaled so the
                // drive is most of the way in before the blade has covered a fifth
                // of its arc. That sequencing is what the strike hangs off.
                shift = -1 + 2 * easeOutQuad(Math.min(1, u * 1.6));
            } else {
                const u = (t - tRecover) / s.recover;
                // The recovery is a cubic Hermite that *starts at exactly the
                // velocity the strike ended with*. So the blade carries through the
                // finish, tops out a little past it, and comes back to guard: one
                // continuous motion containing one reversal, rather than a stop
                // followed by a return. It also only recentres as far as the finish
                // direction — rewinding the whole sweep in reverse is what an
                // amateur swing does.
                // The tangent that makes the join velocity-continuous, derived
                // rather than tuned. The strike leaves at `(2 + ft)·FLOOR / strike`
                // arc-units a second; a Hermite's initial slope is `E / recover`;
                // equating them gives this. Getting it wrong by even a factor of
                // three — which an earlier version did — puts a step in the
                // velocity at the exact moment the blade passes the target, and a
                // step down reads as the blade catching on something.
                const exit = (2 + ft) * STRIKE_FLOOR * (s.recover / s.strike);
                arc = 1 + ft * (2 * u * u * u - 3 * u * u + 1)
                    + exit * (u * u * u - 2 * u * u + u);
                // The stance is the last thing to release.
                set = 1 - easeOutQuad(Scalar.Clamp((u - 0.4) / 0.6, 0, 1));
                shift = 1 - smooth(u);
                want = 1 - Scalar.Clamp((u - 0.35) / 0.65, 0, 1);
            }

            set *= s.set;
            ch.swingPlane = s.plane;
            ch.swingStage = this.stage;
        } else if (this.chain > 0 && this.lastStage >= 1 && this.lastStage < 3) {
            // Between strokes of the string, the stance stays loaded: knees soft,
            // weight forward-ready, for as long as the chain window is open. The
            // body does not fully reset because the combo has not.
            set = 0.30 * (this.chain / CHAIN_WINDOW);
        }

        const on = allowed ? 1 : 0;
        ch.swingBlend = expDamp(ch.swingBlend, want * on, want > ch.swingBlend ? 30 : 12, h);
        // Barely filtered: the curve is already continuous, and a slow filter here
        // would flatten the acceleration that is the whole point of it.
        ch.swingArc = expDamp(ch.swingArc, arc, 60, h);
        ch.swingSet = expDamp(ch.swingSet, set * on, 18, h);
        ch.swingShift = expDamp(ch.swingShift, shift * on, 22, h);
        ch.swingSnap = expDamp(ch.swingSnap, snap, 20, h);
        if (ch.swingBlend < 0.002 && this.stage === 0) {
            ch.swingPlane = 0;
            ch.swingStage = 0;
        }
    }
}

// --------------------------------------------------------------------- easing
//
// Every curve the attack uses, in one place, with what each is for and why it
// rather than one of the others. Each join between phases is chosen so the
// *velocity* matches across it as well as the value — a value-continuous but
// velocity-discontinuous join is a visible flinch, and it is the easiest way to
// make a smooth curve look mechanical.

/** Symmetric ease in and out. Zero velocity at both ends. */
function smooth(x) {
    const t = Scalar.Clamp(x, 0, 1);
    return t * t * (3 - 2 * t);
}

/** Quadratic out: leaves at full speed, arrives at rest. */
function easeOutQuad(x) {
    const t = 1 - Scalar.Clamp(x, 0, 1);
    return 1 - t * t;
}

/**
 * Cubic out. Sharper away and slower into the arrival than the quadratic, which is
 * what a wind-up wants: the blade snaps back and then *loads*, and the slow arrival
 * is the anticipation. Used instead of a literal pause, which reads as a stall.
 */
function easeOutCubic(x) {
    const t = 1 - Scalar.Clamp(x, 0, 1);
    return 1 - t * t * t;
}

/**
 * The strike's sweep. See `STRIKE_POWER` for the measured shape and for why it is
 * not a true exponential.
 */
function strikeCurve(x) {
    const t = Scalar.Clamp(x, 0, 1);
    return (1 - STRIKE_FLOOR) * Math.pow(smooth(t), STRIKE_POWER) + STRIKE_FLOOR * t;
}
