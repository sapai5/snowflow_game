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
 * Clicks during any phase of a running attack are buffered into one flag and consumed
 * when the strike ends, so mashing advances the string and never restarts or breaks it.
 *
 * Allocation per frame: none.
 */

import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { expDamp } from "../core/camera.js";
import { angleDamp, angleDelta } from "./controller.js";

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
        windup: 0.20, strike: 0.28, recover: 0.24,
        drive: 1.7, plane: 1, snap: 0.65, set: 0.45, stomp: 0.3, trauma: 0.10,
        // Overshoot past the target line, in units of half the sweep. The jab's
        // arc is 101 degrees, so 0.70 half-sweeps is ~35 degrees of blade travel
        // past centre before it catches itself.
        followThrough: 0.70,
    },
    {
        // The return stroke. Chained, most of this wind-up never plays — the
        // rebase puts the blade at the coil already and the body just re-orients.
        // A touch wider and heavier than the first: the string is escalating.
        windup: 0.23, strike: 0.32, recover: 0.26,
        drive: 2.2, plane: 3, snap: 0.50, set: 0.55, stomp: 0.45, trauma: 0.13,
        followThrough: 0.62,
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
        windup: 0.50, strike: 0.44, recover: 0.42,
        drive: 8.5, plane: 2, snap: 0.0, set: 1.0, stomp: 1.0, trauma: 0.34,
        // Both hands on the grip. The off hand comes across during the wind-up, holds
        // through the cut, and is released into the recovery — see `swingGrip`.
        twoHand: 1,
        // A shove rather than a nudge. See `SWORD_KNOCKBACK` in `rules.js`: the finisher
        // is the one strike in the string that moves somebody, which is what makes
        // landing it worth the second and a half it costs to throw.
        shove: 1,
        // ~31 degrees past the end of the descending arc, in the same half-sweep units.
        // The cut is vertical now and it ends below the belt, so the overshoot carries the
        // hand down and slightly across rather than around the side — a right hand that has
        // finished a vertical cut has run out of shoulder, not out of momentum, and the
        // envelope clamp catches it if this is ever raised too far.
        followThrough: 0.51,
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
/*
 * The phase lengths above carry most of what makes a fight feel deliberate rather than
 * twitchy, and it is worth naming which part does what, because the temptation is always
 * to slow the strike:
 *
 *   the wind-up is *readability*. It is the only window in which an opponent can see what
 *     is coming and answer it, so a heavy attack needs half a second of it and a light one
 *     needs a fifth. Lengthening this makes a fight legible.
 *   the strike is *the hit*. It should stay fast, because a slow strike does not read as
 *     restrained, it reads as underwater. It is also the parry window, so it is the one
 *     phase where length is a mechanical decision rather than an aesthetic one.
 *   the recovery is *commitment*. It is the price of having swung and missed, and it is
 *     what stops a fight being two people mashing. Lengthening this makes a fight tense.
 *
 * So the wind-ups and recoveries were lengthened and the strikes were left alone. The
 * string runs 2.89 s where it used to run 1.84 s, and almost none of that is the blade
 * moving more slowly.
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
 * Velocity floor on the wind-up, as a fraction.
 *
 * `u^WINDUP_POWER` has zero derivative at u=0, so a wind-up that begins the instant a
 * strike ends begins by not moving — which is the same stop in a different place. Mixing in
 * a linear term means the blade leaves the previous stroke's finish already travelling.
 *
 * Exactly the reasoning behind `STRIKE_FLOOR`, applied to the other end of the reversal.
 */
const WINDUP_FLOOR = 0.30;

/**
 * Soft target tracking during the wind-up: range and half-cone.
 *
 * The wind-ups were lengthened so an attack could be seen and answered, and that bought a
 * problem: a strafing opponent at 3.6 m/s covers 0.72 m during a jab's wind-up and 1.8 m
 * during the finisher's, against a reach of 1.48 m — so without tracking, the deliberate
 * pacing converts directly into whiffs unless the player mouse-follows the strafe by hand.
 * Attacks that miss for no visible reason read as clunk, not as skill.
 *
 * So during the wind-up — and only the wind-up — the facing goal becomes the bearing to a
 * target that is close and roughly where the player is already aiming. The cone is the
 * honesty bound: the attack never rotates more than this far from where the player
 * actually pointed, so it assists aim rather than replacing it. No tracking during the
 * strike, ever — the swept blade and the parry geometry stay honest, and side-stepping a
 * committed swing keeps working. Track the start-up, commit the active frames: that is the
 * contract the genre reference uses.
 */
const TRACK_RANGE = 5;
const TRACK_CONE = (35 * Math.PI) / 180;

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
        /** The plane and arc the blade is bridged *from* during a chained wind-up. */
        this._fromPlane = 0;
        this._fromArc = 0;

        /**
         * Who this combatant might be swinging at: a callback returning the nearest
         * living opponent, or null.
         *
         * Injected by the world rather than imported, because this file deliberately
         * knows nothing about the player table — it is also what lets the tests hand in
         * a fixed target and assert the cone geometry without standing up a world.
         *
         * @type {(() => { controller: { position: {x:number,z:number} } } | null) | null}
         */
        this.findTarget = null;
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
            } else {
                // Any click during an attack queues the next stroke — including clicks
                // during the wind-up, which used to be dropped on the theory that "again"
                // is not meaningful before the strike has released. That theory was
                // written against 0.12 s wind-ups; at 0.20–0.50 s it made a third of the
                // string input-dead, and an input that sometimes counts and sometimes
                // does not is the textbook mechanism of "feels unresponsive". A single
                // flag consumed at strike-end means a double-click is exactly this attack
                // plus the next one queued, which is what a double-click means everywhere.
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
                // Soft tracking: if somebody is close and roughly down the aim line, the
                // goal is *them* rather than the abstract aim direction. Bounded by the
                // cone, so the attack can never rotate further from the player's actual
                // aim than TRACK_CONE — see the constants for why this exists at all.
                let goal = aim;
                if (this.findTarget) {
                    const foe = this.findTarget();
                    if (foe) {
                        const dx = foe.controller.position.x - ch.position.x;
                        const dz = foe.controller.position.z - ch.position.z;
                        const d2 = dx * dx + dz * dz;
                        if (d2 > 1e-6 && d2 <= TRACK_RANGE * TRACK_RANGE) {
                            const bearing = Math.atan2(dx, dz);
                            if (Math.abs(angleDelta(aim, bearing)) <= TRACK_CONE) {
                                goal = bearing;
                            }
                        }
                    }
                }
                ch.facing = angleDamp(ch.facing, goal, 16, h);
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
            const prev = STAGES[this.lastStage - 1];
            const shift = 2 + prev.followThrough;
            this.ch.swingArc -= shift;
            this.ch.swingRebase -= shift;
            this._startArc = -1;
            // Where the blade actually is, for the wind-up to travel *from*. The rebase
            // above puts the arc at the coil, which is where the new stroke must start
            // from — but it is not where the blade is, and pretending otherwise is what
            // left the wind-up with nothing to move through. The figure bridges between
            // the two; see `swingDirection`.
            //
            // Analytically the previous strike's curve finishes at `1 + followThrough`.
            this._fromPlane = prev.plane;
            this._fromArc = 1 + prev.followThrough;
        } else {
            this._startArc = 0;
            this._fromPlane = 0;
            this._fromArc = 0;
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
        rig.addTrauma(s.trauma);
        // No hit-stop here, deliberately. This fires on every swing at the velocity
        // peak whether or not anything was struck — it is where the terrain cut and
        // the camera kick belong — and the phase-timed hit-stop it used to apply gave
        // every *whiffed* swing a 45–75 ms slow-motion hiccup, indistinguishable from
        // a dropped frame. Hit-stop is a statement that contact happened, so it lives
        // in the resolver, which is the only thing that knows whether it did; landed
        // hits were also stacking that contact stop on top of this one.
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
        let gripWant = 0;
        let bridge = 0;
        // Movement authority, published for the controller. 1 means unimpeded.
        let move = 1;

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
                // Half authority while aiming. The flat 20% this used to be treated the
                // wind-up like the strike, and the wind-up is where the player is still
                // *placing* the attack — walking it onto a strafing target is the skill
                // the long wind-ups exist to reward.
                move = 0.5;
                // The off hand joins during the coil and is gone by the end of the
                // recovery, so the two-handed grip is part of the anticipation rather
                // than something that appears at the moment of contact.
                gripWant = s.twoHand ? 1 : 0;
                // Accelerating into the coil — see `WINDUP_POWER`. It leaves guard gently
                // and arrives at the coil already travelling, so the reversal into the
                // strike is an instant rather than a rest.
                //
                // Floored, so a chained wind-up departs the previous stroke's finish at a
                // real rate instead of easing out of zero — see `WINDUP_FLOOR`.
                const w = WINDUP_FLOOR * u + (1 - WINDUP_FLOOR) * Math.pow(u, WINDUP_POWER);
                // A chained wind-up's arc holds at the coil, because the coil is where the
                // strike must begin; the travel between the previous stroke's finish and
                // that coil is the *bridge*, and it runs off the same curve so the blade's
                // journey and the body's re-orientation are one motion rather than two.
                arc = this._startArc + (-1 - this._startArc) * w;
                bridge = this._fromPlane > 0 ? 1 - w : 0;
                set = easeOutCubic(u);
                shift = -easeOutCubic(u);
            } else if (t < tRecover) {
                const u = (t - tStrike) / s.strike;
                // Committed: the strike keeps the old lock in full. This is the phase
                // where planting the feet is the point, and it is also the parry window,
                // so mobility here is a balance number rather than a feel number.
                move = 0.2;
                gripWant = s.twoHand ? 1 : 0;
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
                // Footwork comes back across the recovery rather than after it. The
                // flat lock held the player at 20% authority through the whole recovery
                // and then the blend release and re-acceleration stacked on top — about
                // 0.8 s below half speed for one whiffed jab. Recovery still costs (you
                // cannot sprint out of a whiff, and the chain-cancel is unaffected),
                // but a drift is a fight continuing where a freeze is a fight pausing.
                move = 0.35 + 0.45 * u;
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
        // Release at 20 rather than 12: the pose easing out over a fifth of a second was
        // a third layer of movement lock stacked after the recovery had already ended.
        ch.swingBlend = expDamp(ch.swingBlend, want * on, want > ch.swingBlend ? 30 : 20, h);
        ch.swingMove = move;
        // Barely filtered: the curve is already continuous, and a slow filter here
        // would flatten the acceleration that is the whole point of it.
        ch.swingArc = expDamp(ch.swingArc, arc, 60, h);
        ch.swingSet = expDamp(ch.swingSet, set * on, 18, h);

        // Two hands on the grip, for the strokes that ask for it.
        //
        // Rises through the wind-up, holds flat across the strike, and releases through
        // the recovery. Asymmetric rates on purpose: bringing the off hand across is a
        // deliberate act and part of the anticipation, so it is unhurried; letting go is
        // a consequence of the follow-through pulling the arms apart, so it is quick.
        ch.swingGrip = expDamp(
            ch.swingGrip, gripWant * on,
            gripWant > ch.swingGrip ? 7 : 14, h
        );

        // Not filtered. The bridge is already a smooth function of the wind-up's own curve,
        // and damping it would leave a residue after the wind-up ended — a blade still
        // being pulled toward the previous stroke's direction while the strike has started.
        ch.swingBridge = bridge * on;
        ch.swingFromPlane = this._fromPlane;
        ch.swingFromArc = this._fromArc;
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
