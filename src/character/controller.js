/**
 * Character locomotion + snow-surf physics.
 *
 * This owns motion only — the visual rig, cloth and fur read the state this
 * produces. Two modes share one integrator:
 *
 *  - WALK: camera-relative desired velocity, eased facing, distance-driven gait
 *    phase so footfalls land where the feet actually are (no sliding).
 *  - SURF: momentum-carrying. Thrust along facing, steering from mouse yaw,
 *    strong lateral grip that bleeds into a drift as you push the carve, and
 *    slope-driven acceleration so dropping down a dune face feels like a gain.
 *
 * Blending between them is eased in both directions; there is no snap.
 *
 * Jumping sits on top of both. It is the only part of this file that owns a
 * vertical velocity — everywhere else the character is glued to the surface —
 * and it keeps the mode it launched in: a walking jump is steerable, an ollie off
 * the board holds its heading. Neither holds its *speed*: nothing drives the
 * board while it is in the air, and the landing is an inelastic collision, so a
 * jump on the board is paid for out of momentum. A second press in the air spends
 * the one air jump on a front somersault, timed to finish before the ground
 * arrives.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { expDamp } from "../core/camera.js";
import { IDLE_INTENT } from "../game/intent.js";

const _wish = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _tmp = new Vector3();
const _n = new Vector3();

/*
 * Ground speeds, slowed a second time for the fight.
 *
 * What makes a deliberate melee legible is not slowness but the *ratio* between how long
 * an attack takes and how far an opponent can move in that time, and it is worth writing
 * the arithmetic down because the intuition is misleading: lengthening the wind-ups and
 * slowing the movement largely cancel. The finisher's wind-up went from 0.38 s to 0.50 s
 * while the run went from 4.4 to 3.6, so the ground an opponent covers while it loads
 * barely changed — 1.7 m to 1.8 m.
 *
 * That number is the one that matters, and it is the reason these are only slowed a
 * little. Reach is about 1.48 m from body centre to blade tip, so 1.8 m of travel during a
 * wind-up means a heavy attack can be walked out of if it is seen coming and cannot be if
 * it is not. Slowing movement much further would not make fights more readable; it would
 * make crossing a 240 m field take a minute.
 */
const WALK_SPEED = 1.9;
/**
 * Sprint. Slowed from 5.4, then from 4.4: at a fighting distance the old speeds made
 * spacing hard to read, and a sprint that outruns a swing makes the swing pointless.
 */
const RUN_SPEED = 3.6;
/**
 * Ground acceleration, m/s^2.
 *
 * 26 was effectively instant — top speed in a fifth of a second — and a character that
 * reaches full pace inside two frames has no start to animate. Eight gives just under half
 * a second from standing to a run.
 *
 * The lower it goes the more the character reads as having mass, and it is also what makes
 * a fight's footwork *cost* something: a sidestep that begins instantly is free, and one
 * that takes a fifth of a second to build is a decision. That is most of the difference
 * between a twitch fight and a deliberate one, and it is worth more here than any amount
 * of top-speed reduction.
 */
const WALK_ACCEL = 8;
const WALK_DECEL = 12;
/**
 * How fast the body comes round to a new heading, as a damping rate.
 *
 * Slowed from 11. Turning is the other half of footwork having weight — a character that
 * pivots instantly can answer an attack from any direction with no commitment at all,
 * which removes the reason to face anybody in particular.
 */
const TURN_RATE = 8;

/**
 * Surf ceiling, slowed from 19.5. Still three times a sprint, so it remains *the*
 * way to cross ground, but it is now a speed a fight can survive being interrupted
 * by. Surfing cannot attack, so it stays a commitment: fast, and unarmed.
 */
const SURF_MAX = 13.0;
const SURF_THRUST = 8.5;
const SURF_DRAG = 0.42;
const SURF_TURN = 2.35; // rad/s at full steer
const SURF_GRIP = 7.5;
/**
 * Gravity along the slope, m/s^2 per unit grade.
 *
 * Well above real gravity: the slopes here are gentler than a real run and the terminal
 * speed is set by drag rather than by the hill, so the pull has to be exaggerated for a
 * descent to feel like one.
 */
const SURF_GRAVITY = 26;
/** How hard pulling back scrubs speed, m/s^2. Drag, never reverse thrust. */
const SURF_BRAKE = 14;

// --------------------------------------------------------------------- jump
/**
 * Gravity is lighter than Earth on purpose. At 9.81 the arc is over before the
 * legs have finished tucking, which at this camera distance reads as a twitch.
 */
const GRAVITY = 18.0;
/** ~0.48 m apex, ~0.46 s of air — a hop, not a leap. */
const JUMP_SPEED = 4.15;
/** Off the board the whole body is already moving; the ollie gets more. */
const SURF_JUMP_SPEED = 5.05;
/**
 * The second jump. Stronger than the first because it has to buy enough air to
 * turn a somersault in and still leave time to come out of it upright.
 */
const AIR_JUMP_SPEED = 5.8;
/** How many jumps are available once the ground is gone. */
const AIR_JUMPS = 1;
/**
 * Releasing the key early bleeds the rise away instead of cutting it dead, so
 * a tap is a hop and a hold is a full jump with nothing discontinuous between.
 */
const JUMP_CUT_RATE = 9.0;
/**
 * Take-off boost along the current heading, at full running speed. A jump out
 * of a run should cover ground — landing on the spot you left is the thing that
 * makes a jump feel like it was fighting you.
 */
const JUMP_BOOST = 0.22;
/** Extra push the second jump adds along the heading, m/s at running speed. */
const AIR_JUMP_PUSH = 1.4;
/** Air control while walking: enough to steer a jump, not to fly it. */
const AIR_ACCEL = 9.0;
/**
 * Quadratic drag on the board while airborne, as a fraction of the ground
 * coefficient.
 *
 * The ground integrator is a fight between thrust and drag, which is why a run
 * settles at a terminal speed. In the air there is no thrust — nothing is being
 * bent, nothing is being pushed against — so this is the whole of it, and speed
 * decays for the length of the flight instead of being carried through it
 * untouched.
 */
const SURF_AIR_DRAG = 0.35;
/**
 * Speed lost to a landing on the board, at the hardest landing the game
 * produces.
 *
 * A board arriving with vertical speed drives itself into the snow and has to be
 * pushed back up onto plane. Perfectly conserving momentum through a drop was the
 * least physical thing the jump did: a landing is an inelastic collision with the
 * ground and it needs to read as one.
 */
const SURF_LAND_SCRUB = 0.34;
/**
 * Fraction of horizontal speed the mid-air jump spends while surfing.
 *
 * The second jump has nothing to push off, so the vertical impulse has to come
 * from somewhere, and taking it out of forward speed is both the honest answer
 * and the thing that stops a double jump being free distance.
 */
const AIR_JUMP_COST = 0.15;

// --------------------------------------------------------------------- plow
/**
 * A board that has just landed is not planing — it is *in* the snow, and it has
 * to climb back out before thrust means anything again.
 *
 * This is the state that makes jumping cost something over more than one frame.
 * A per-landing speed scrub on its own is nearly invisible in play, because the
 * ground integrator hauls the speed back to terminal in about a second: pay 17%,
 * get it back before you can press the key again, and a chain of jumps is free.
 * Bogging the board instead means the *recovery* is the price, and it is a price
 * that compounds — land while still plowing and the clock starts over.
 *
 * Landings refresh the plow rather than deepening it. One landing already takes
 * the board off plane; a second cannot take it further off, it can only keep it
 * there longer, and "longer" is what a chain of jumps is.
 */
const PLOW_ON_LAND = 0.45;
const PLOW_PER_IMPACT = 0.75;
/** 1/s, so a full plow clears in about three quarters of a second. */
const PLOW_RECOVER = 1.3;
/** How much of the thrust a fully plowing board loses. */
const PLOW_THRUST_LOSS = 0.70;
/** Extra deceleration while plowing, m/s^2 — the snow the board is ploughing. */
const PLOW_DRAG = 2.5;
/**
 * Speed at which ploughing resistance reaches full strength, m/s.
 *
 * Below this it tapers to nothing, so a buried board is slow to get going rather than
 * welded in place.
 */
const PLOW_DRAG_SPEED = 3.0;
/** Grace period after leaving the ground where a jump still counts. */
const COYOTE_TIME = 0.12;
/** How early a press is still honoured if it lands just before touchdown. */
const JUMP_BUFFER = 0.14;
/**
 * The somersault finishes at this fraction of the remaining airtime, so the
 * figure is upright and extended for the last moment before it lands. Landing
 * mid-rotation is the difference between a trick and a fall.
 */
const FLIP_COMPLETE_AT = 0.82;

/**
 * Gait: metres of travel per full stride cycle — two footfalls.
 *
 * Linear in speed, and the two constants are measured off people rather than
 * chosen: a person moving at 2.5 m/s covers about 2.2 m per cycle, which is
 * 2.3 steps a second, and at 5.4 m/s covers about 3.4 m, which is 3.2 steps a
 * second. The previous model was a near-constant 1.5 m per cycle, and that is
 * where the "legs going twice as fast as the character" came from: at a run it
 * was asking for six and a half footfalls a second, a cadence no one has ever
 * produced on foot.
 */
const STRIDE_REST = 1.15;
const STRIDE_PER_SPEED = 0.42;

export class CharacterController {
    /**
     * @param {{ heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:Vector3):Vector3 }} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        this.position = new Vector3(0, 0, 0);
        this.velocity = new Vector3(0, 0, 0);
        this.prevVelocity = new Vector3(0, 0, 0);
        this.acceleration = new Vector3(0, 0, 0);

        this.facing = 0; // yaw, radians
        this.speed = 0;
        this.speed01 = 0; // normalised against SURF_MAX, for FOV/wind

        /** 0 = walking, 1 = fully surfing. Eased. */
        this.surf = 0;
        this.surfActive = false;

        // -------------------------------------------------------------- jump
        /** Vertical velocity, m/s. Only meaningful while airborne. */
        this.velocityY = 0;
        /** True from the frame of take-off to the frame of touchdown. */
        this.airborne = false;
        /**
         * 0..1 eased version of `airborne`, for anything that has to blend
         * rather than switch — the figure's leg pose, mainly. Same reasoning as
         * `surf`: a boolean here puts a one-frame snap in the rig.
         */
        this.air = 0;
        /** Metres above the ground directly below. 0 while grounded. */
        this.airHeight = 0;
        /** Seconds since take-off. */
        this.airTime = 0;
        /** Set true for exactly one frame on take-off. */
        this.jumped = false;
        /** Set true for exactly one frame on touchdown. */
        this.landed = false;
        /** 0..1 landing severity, from the vertical speed at touchdown. */
        this.landImpact = 0;
        /**
         * 0..1: how far the board is buried after a landing. Bleeds thrust and
         * adds drag until it clears, which is what makes a chain of jumps cost
         * speed instead of costing one frame of it.
         */
        this.plow = 0;
        /** Air jumps still available. Refilled on the ground. */
        this.airJumpsLeft = AIR_JUMPS;

        // --------------------------------------------------------- somersault
        /**
         * The double jump turns a front somersault. Progress runs 0..1 and the
         * rate is set at take-off from the predicted airtime, so the rotation
         * ends before the ground arrives rather than at whatever moment a fixed
         * spin rate happens to reach.
         */
        this.flip = 0;
        this.flipActive = false;
        /** Body rotation to apply about the pelvis, radians, one full turn. */
        this.flipAngle = 0;
        /** 0..1, how much the figure should be tucked for the rotation. */
        this.flip01 = 0;
        /** True from the air jump until the landing it ends in. */
        this.somersaulted = false;
        this._flipRate = 0;

        this._jumpBuffer = 0;
        this._coyote = COYOTE_TIME;
        /**
         * Speed the current jump launched at. Air control steers toward this
         * rather than toward the walking maximum, so a running jump keeps the
         * speed it left with instead of being scrubbed back to a walk in flight.
         */
        this._airSpeedCap = 0;

        /**
         * 0 = not casting, 1 = fully in the bending stance. Written by the spell
         * system, read by the figure.
         *
         * It lives here rather than on the spell system because the figure
         * already reads the controller for everything else it poses from, and a
         * second source of "what is this character doing" is how the arms and the
         * legs end up disagreeing about which frame it is.
         */
        /**
         * What this character is being told to do, as handed to `update`. Held so
         * the step helpers can read it without it being threaded through every
         * signature, and so anything downstream (the combo, mainly) can see the
         * same intent the movement saw.
         */
        this.intent = IDLE_INTENT;
        /**
         * Movement multiplier from status effects, 0..1. Written by whoever owns the
         * effects — the player — rather than read from them here, so the controller
         * stays ignorant of what a Wave is and only ever sees "you are at 60%".
         */
        this.moveScale = 1;

        this.cast = 0;
        this.castAimX = 0;
        this.castAimY = 0;
        this.castAimZ = 1;

        /**
         * Sword combo state, written by `SwordCombat` and read by the figure and
         * the blade. It lives here for the same reason `cast` does: the figure
         * already reads the controller for everything it poses from, and a second
         * source of "what is this character doing" is how the arms and the legs
         * end up disagreeing about which frame it is.
         *
         * `swingBlend` is the weight of the attack pose, `swingArc` runs -1 at
         * full wind-up through +1 at the end of the follow-through, and
         * `swingPlane` is which of the three attacks is playing.
         */
        this.swingBlend = 0;
        this.swingArc = 0;
        this.swingPlane = 0;
        /**
         * How planted the stance is: wide, low, and weight-shifted. Held through
         * the whole strike and released late, so an attack finishes grounded.
         */
        this.swingSet = 0;
        /** How much hip/torso separation the current attack removes, 0..1. */
        this.swingSnap = 0;
        /**
         * How much of both hands is on the grip, 0..1.
         *
         * Only the finisher asks for it. Written by the combo and read by the figure,
         * which brings the off hand across to the handle instead of letting it keep its
         * locomotion swing.
         */
        this.swingGrip = 0;
        /**
         * How much of a chained wind-up is still to travel, 1 down to 0.
         *
         * While it is non-zero the figure interpolates the hand's direction *between
         * planes* — from where the previous stroke left the blade to where this one coils.
         * Without it a chained wind-up held the blade perfectly still for its whole
         * duration, which is what a combo stopping between strokes looked like.
         */
        this.swingBridge = 0;
        /** Which plane the blade is being bridged *from*, and at what arc. */
        this.swingFromPlane = 0;
        this.swingFromArc = 0;
        /**
         * Phase shift the figure's lag springs must apply this frame, then clear.
         * Written when a chained attack rebases the arc into its own plane, so the
         * springs move with it instead of seeing a two-unit step.
         */
        this.swingRebase = 0;
        /**
         * Seconds of hit-stop remaining. While non-zero the combat's phase clock
         * and the figure's swing springs hold, which is the freeze-frame at
         * contact.
         */
        this.hitstop = 0;
        /** Weight along the facing: -1 on the back leg, +1 driven onto the front. */
        this.swingShift = 0;
        /** Which attack of the chain is playing, 0 when none is. */
        this.swingStage = 0;
        /**
         * True while an attack is running. Written by `SwordCombat`, and the flag
         * anything else should test rather than inferring it from the blend weight,
         * which is still non-zero while the pose eases out.
         */
        this.attacking = false;
        /** Set true for exactly one frame at the moment a strike connects. */
        this.slashHit = false;
        /** Set true for exactly one frame when the front foot takes the drive. */
        this.stompHit = false;
        /** 0..1 how heavy that strike was — stage 3 is the heaviest. */
        this.slashStrength = 0;

        /** Signed lean, -1..1 (right positive), from lateral acceleration. */
        this.lean = 0;
        /** Signed carve amount for wake shaping. Positive = turning right. */
        this.carve = 0;
        /**
         * 0..1, how hard the screen-space speed streaks should read. Deadbanded
         * well above walking pace: streaks at a jog make the demo feel cheap.
         */
        this.streak01 = 0;

        // ------------------------------------------------------------- gait
        this.gaitPhase = 0;
        /**
         * Metres of ground per full stride cycle. Published because the figure
         * has to place its feet against the same number the phase advances with,
         * and two copies of a stride model is two chances for the feet to skate.
         */
        this.strideLength = STRIDE_REST;
        /**
         * True when the legs should be running a gait at all.
         *
         * One flag, read by the figure and by the contact system, because three
         * copies of "is this character walking" is three chances for the feet to
         * disagree with the footprints.
         */
        this.stepping = true;
        /** Set true for exactly one frame when a foot plants. */
        this.footfall = false;
        /** 0 = left foot, 1 = right foot — which foot just planted. */
        this.footIndex = 0;
        /** World position of the foot that just planted. */
        this.footPos = new Vector3();
        /** Impact strength 0..1, scales spray and deformation depth. */
        this.footImpact = 0;

        this.groundY = 0;
        this.groundNormal = new Vector3(0, 1, 0);

        this._prevSpeed = 0;
    }

    /**
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {ReturnType<typeof import("../game/intent.js").makeIntent>} [intent]
     *   what this character is being told to do. Defaults to doing nothing, which
     *   is the right default for a character nobody is driving yet.
     */
    update(dt, rig, intent) {
        const h = Math.min(dt, 1 / 30);
        // Held for the duration of the step, so the private helpers do not each
        // need it threaded through their signatures.
        const input = intent || IDLE_INTENT;
        this.intent = input;

        this.prevVelocity.copyFrom(this.velocity);
        this.surfActive = input.surf;
        this.jumped = false;
        this.landed = false;
        this.slashHit = false;
        this.stompHit = false;
        this.hitstop = Math.max(0, this.hitstop - h);

        // Ease the surf blend — entering and exiting are transitions, not switches.
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);

        rig.getFlatForward(_fwd);
        rig.getFlatRight(_right);

        // Jump intent. Buffering the press and forgiving the last few
        // milliseconds of ground contact are both invisible when they work and
        // the entire difference between a jump that answers and one that eats
        // inputs at the top of a dune.
        if (input.jumpPressed) this._jumpBuffer = JUMP_BUFFER;
        else this._jumpBuffer = Math.max(0, this._jumpBuffer - h);
        this._coyote = this.airborne ? Math.max(0, this._coyote - h) : COYOTE_TIME;

        // The board climbing back onto plane. Linear, so the time to recover is a
        // number rather than an asymptote — see `PLOW_ON_LAND`.
        this.plow = Math.max(0, this.plow - PLOW_RECOVER * h);

        if (this.airborne) this._airStep(h, rig);
        else if (this.surf > 0.5) this._surfStep(h, rig);
        else this._walkStep(h);

        // One jump off the ground, one more in the air. The air jump is what
        // carries the somersault.
        if (!this.airborne) {
            if (this._jumpBuffer > 0 && this._coyote > 0) this._takeOff(false);
        } else if (this._jumpBuffer > 0 && this.airJumpsLeft > 0) {
            this._takeOff(true);
        }

        // ---------------------------------------------------- integrate + snap
        this.position.x += this.velocity.x * h;
        this.position.z += this.velocity.z * h;

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);

        if (this.airborne) {
            this.airTime += h;
            // Hold to rise: letting go bleeds the remaining climb away.
            if (!input.jump && this.velocityY > 0) {
                this.velocityY *= Math.exp(-JUMP_CUT_RATE * h);
            }
            this.velocityY -= GRAVITY * h;
            this.position.y += this.velocityY * h;
            if (this.position.y <= this.groundY) this._land(rig);
        } else {
            // Snap with a little softness so micro-ripples don't jitter the rig.
            this.position.y = expDamp(this.position.y, this.groundY, 26, h);
            this.velocityY = 0;
        }

        this.airHeight = Math.max(0, this.position.y - this.groundY);
        this.air = expDamp(this.air, this.airborne ? 1 : 0, 16, h);
        this._flipStep(h);

        // --------------------------------------------------------- bookkeeping
        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Scalar.Clamp(this.speed / SURF_MAX, 0, 1);

        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        // Lateral acceleration → lean. Project accel onto the character's right.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.surf);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);

        this.streak01 = this.surf * Scalar.Clamp((this.speed - 7) / 11, 0, 1);

        this._gait(h);
    }

    /**
     * Drive from the network instead of from physics.
     *
     * A remote player's own client already decided where it is. Simulating it again here
     * would produce a second, slightly different answer that then has to be corrected
     * back toward the first — which is the prediction-and-reconciliation machinery the
     * trusted-client model exists to avoid. So position, velocity, facing and the two
     * mode flags are written by `RemoteDriver` before this runs, and this does not touch
     * them.
     *
     * Everything the figure needs that is *not* on the wire is still computed here, from
     * the interpolated position: ground height and normal, the surf and air blends,
     * lateral lean, the streak threshold and the gait phase. Sending those would be
     * about eight more numbers per player per snapshot to say something both ends can
     * work out for themselves; not computing them at all is a remote player sliding
     * across the snow in a T-pose.
     *
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {ReturnType<typeof import("../game/intent.js").makeIntent>} [intent]
     */
    applyNetwork(dt, rig, intent) {
        const h = Math.min(dt, 1 / 30);
        const input = intent || IDLE_INTENT;
        this.intent = input;

        this.jumped = false;
        this.landed = false;
        this.slashHit = false;
        this.stompHit = false;
        this.hitstop = Math.max(0, this.hitstop - h);
        this.plow = Math.max(0, this.plow - PLOW_RECOVER * h);

        // Blended locally from the flag rather than sent as a blend value: it is a
        // smooth function of a boolean both ends already have.
        this.surf = expDamp(this.surf, this.surfActive ? 1 : 0, this.surfActive ? 2.6 : 3.4, h);

        this.groundY = this.terrain.heightAt(this.position.x, this.position.z);
        this.terrain.normalAt(this.position.x, this.position.z, this.groundNormal);
        this.airHeight = Math.max(0, this.position.y - this.groundY);
        this.air = expDamp(this.air, this.airborne ? 1 : 0, 16, h);
        if (this.airborne) this.airTime += h;
        else this.airTime = 0;
        this._flipStep(h);

        this.speed = Math.hypot(this.velocity.x, this.velocity.z);
        this.speed01 = Scalar.Clamp(this.speed / SURF_MAX, 0, 1);

        // Acceleration from the difference between snapshots, which is what drives lean.
        // `prevVelocity` is captured at the *end* of this method rather than the start,
        // because the driver has already overwritten `velocity` by the time we get here
        // — capturing it first would compare this frame's velocity with itself and the
        // figure would never lean into a turn.
        this.acceleration.x = (this.velocity.x - this.prevVelocity.x) / h;
        this.acceleration.z = (this.velocity.z - this.prevVelocity.z) / h;

        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const latAcc = this.acceleration.x * rx + this.acceleration.z * rz;
        const leanWant = Scalar.Clamp(latAcc / 26, -1, 1) * (0.35 + 0.65 * this.surf);
        this.lean = expDamp(this.lean, leanWant, 6.5, h);
        this.carve = expDamp(this.carve, leanWant, 9, h);
        this.streak01 = this.surf * Scalar.Clamp((this.speed - 7) / 11, 0, 1);

        this._gait(h);
        this.prevVelocity.copyFrom(this.velocity);
    }

    /**
     * Leave the ground, or leave it again. Called from `update` once the ground
     * step has run, so the launch inherits this frame's horizontal velocity
     * rather than last frame's.
     *
     * @param {boolean} fromAir true for the second, mid-air jump
     */
    _takeOff(fromAir) {
        const speed = Math.hypot(this.velocity.x, this.velocity.z);
        const run = Math.min(1, speed / RUN_SPEED);
        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        if (fromAir) {
            this.airJumpsLeft--;
            this.velocityY = AIR_JUMP_SPEED;
            if (this.surf > 0.5) {
                // On the board the second jump is bought, not given: the vertical
                // impulse comes out of the horizontal.
                const k = 1 - AIR_JUMP_COST;
                this.velocity.x *= k;
                this.velocity.z *= k;
            } else {
                // On foot it is a platforming aid, and a push rather than a
                // scale: a standing double jump should still carry forward a
                // little, and scaling zero is zero.
                this.velocity.x += fx * AIR_JUMP_PUSH * (0.35 + 0.65 * run);
                this.velocity.z += fz * AIR_JUMP_PUSH * (0.35 + 0.65 * run);
            }
            this._beginFlip();
        } else {
            this.airborne = true;
            this.airTime = 0;
            this.airJumpsLeft = AIR_JUMPS;
            this.velocityY = this.surf > 0.5 ? SURF_JUMP_SPEED : JUMP_SPEED;
            // Ground jumps convert a little of the run into distance. Scaled by
            // speed, so a standing jump goes straight up.
            //
            // Not on the board: the surf integrator has a terminal speed, and a
            // multiplier applied outside it is a way to exceed that speed by
            // hopping — which would make the fastest line a series of ollies.
            if (this.surf <= 0.5) {
                const boost = 1 + JUMP_BOOST * run;
                this.velocity.x *= boost;
                this.velocity.z *= boost;
            }
        }

        this._jumpBuffer = 0;
        this._coyote = 0;
        this.jumped = true;
        // Air control steers toward this, so neither jump can be scrubbed back
        // to a walking pace in flight.
        const launchSpeed = Math.hypot(this.velocity.x, this.velocity.z);
        this._airSpeedCap = fromAir
            ? Math.max(this._airSpeedCap, launchSpeed)
            : launchSpeed;

        // The soft ground snap can leave the character a centimetre under the
        // surface; starting the arc from below it would clip straight back into
        // the landing branch on the next frame.
        if (this.position.y < this.groundY) this.position.y = this.groundY;
        // A jump breaks the stride. Restarting the gait from a plant on landing
        // rather than mid-swing is what stops the legs from scissoring on
        // touchdown.
        this.gaitPhase = 0;
    }

    /**
     * Start the somersault, and decide how fast it has to turn.
     *
     * The rotation is timed against the arc it is being thrown from — solve the
     * ballistic flight for when this height comes back to the ground, then turn
     * one revolution inside a fraction of it. The alternative, a constant spin
     * rate, lands the figure at whatever angle it happens to have reached.
     */
    _beginFlip() {
        const vy = this.velocityY;
        const drop = Math.max(0, this.position.y - this.groundY);
        // t for y(t) = 0, from vy and the height above the ground.
        const airtime = (vy + Math.sqrt(vy * vy + 2 * GRAVITY * drop)) / GRAVITY;
        this.flip = 0;
        this.flipActive = true;
        this.somersaulted = true;
        this._flipRate = 1 / Math.max(0.2, airtime * FLIP_COMPLETE_AT);
    }

    /**
     * Advance the somersault. One revolution, eased at both ends so the figure
     * winds into it and comes out of it rather than snapping to a spin rate.
     */
    _flipStep(h) {
        if (!this.flipActive && this.flip <= 0) {
            this.flipAngle = 0;
            this.flip01 = 0;
            return;
        }

        // If the ground arrived early — a landing on a rising dune face — finish
        // the turn fast rather than freezing part-way through it.
        const rate = this.airborne ? this._flipRate : Math.max(this._flipRate, 4.5);
        this.flip = Math.min(1, this.flip + rate * h);

        // Ease in and out: smoothstep on the progress, so the rotation has an
        // acceleration and a settle instead of a constant angular velocity.
        const s = this.flip;
        const eased = s * s * (3 - 2 * s);
        this.flipAngle = eased * Math.PI * 2;
        // Tucked through the middle of the rotation, extended at both ends.
        this.flip01 = Math.sin(Math.PI * Math.min(1, s * 1.06));

        if (this.flip >= 1) {
            // A full turn is the identity. Clearing it here rather than easing it
            // back is what keeps the exit clean.
            this.flipActive = false;
            this.flip = 0;
            this.flipAngle = 0;
            this.flip01 = 0;
        }
    }

    /**
     * Touchdown.
     * @param {import("../core/camera.js").CameraRig} rig
     */
    _land(rig) {
        // Severity from the vertical speed, not from the height fallen: landing
        // on a rising dune face is a shorter fall and a softer landing, and that
        // falls out of this for free.
        this.landImpact = Scalar.Clamp(-this.velocityY / 11, 0, 1);
        this.position.y = this.groundY;
        this.velocityY = 0;
        this.airborne = false;
        this.landed = true;
        this._coyote = COYOTE_TIME;
        this.airJumpsLeft = AIR_JUMPS;
        this._airSpeedCap = 0;

        // Coming out of a somersault is a landing the character chose. It shakes
        // the camera less than dropping out of the sky, and it costs a little less
        // speed — but only a little. The ground does not care how stylish the
        // approach was.
        const graceful = this.somersaulted ? 0.45 : 1;
        const styled = this.somersaulted ? 0.8 : 1;
        this.somersaulted = false;

        // A landing costs speed in both modes. Boots dig in; a board arriving with
        // vertical speed drives itself into the snow and has to be pushed back up
        // onto plane. Scaled by the vertical speed that arrived, so dropping off a
        // crest at a shallow angle is nearly free and coming down out of a double
        // jump is not.
        const scrub = this.surf > 0.5
            ? SURF_LAND_SCRUB * this.landImpact * styled
            : 0.28 * this.landImpact * graceful;
        const k = 1 - Scalar.Clamp(scrub, 0, 0.6);
        this.velocity.x *= k;
        this.velocity.z *= k;

        // And the board is now in the snow rather than on it. Refreshed rather
        // than accumulated — see `PLOW_ON_LAND`.
        if (this.surf > 0.5) {
            this.plow = Math.min(
                1,
                Math.max(this.plow, PLOW_ON_LAND + PLOW_PER_IMPACT * this.landImpact)
            );
        }

        rig.addTrauma((0.10 + 0.30 * this.landImpact) * graceful);
    }

    /**
     * Airborne step. Two very different contracts, for the same reason the
     * ground has two: on foot a jump is steerable, on the board it is ballistic.
     *
     * @param {number} h
     * @param {import("../core/camera.js").CameraRig} rig
     */
    _airStep(h, rig) {
        const input = this.intent;
        if (this.surf > 0.5) {
            // Direction is sacred here: steering rotates the body — a spin — and
            // deliberately does not redirect the velocity, so an ollie off a
            // crest lands where it was pointed when it left.
            const steer = Scalar.Clamp(
                input.moveX * 0.85 + angleDelta(this.facing, rig.yaw) * 1.25,
                -1,
                1
            );
            this.facing += steer * SURF_TURN * 0.55 * h;

            // Speed is not. Nothing is driving the board while it is off the
            // ground, so drag has the flight to itself: about a metre a second out
            // of a full-speed ollie, more out of the higher arc a double jump
            // buys. The landing takes the rest — see `_land`.
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const drag = (SURF_DRAG * s * s * 0.02 + 0.9) * SURF_AIR_DRAG;
                const k = Math.max(0, s - drag * h) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
            return;
        }

        // Steer toward whichever is faster: the walking maximum, or the speed
        // this jump launched at. Steering must not be a brake.
        //
        // Scaled by the effect multiplier, which is what makes Updraft's "movement
        // restricted by 75%" mean anything: it throws you into the air and then takes
        // away most of your ability to choose where you land.
        const maxSpeed = Math.max(
            (input.sprint ? RUN_SPEED : WALK_SPEED) * this.moveScale,
            this._airSpeedCap * this.moveScale
        );

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen < 0.001) return; // no air friction — a jump keeps its speed

        _wish.x = (_wish.x / wishLen) * maxSpeed;
        _wish.z = (_wish.z / wishLen) * maxSpeed;

        const a = AIR_ACCEL * h;
        this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
        this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

        // Turning in the air is slower than on the ground, which is both true
        // and the cheapest way to make a jump feel like it has weight. The
        // somersault holds its heading: you cannot steer out of a rotation.
        const turn = 5.0 * (1 - this.flip01);
        if (turn > 0.05) {
            this.facing = angleDamp(this.facing, Math.atan2(_wish.x, _wish.z), turn, h);
        }
    }

    _walkStep(h) {
        const input = this.intent;
        // Swinging a sword costs you your feet. A committed attack is a committed
        // attack: the drive comes from the legs, so the legs are not also available
        // for walking while it happens.
        //
        // Status effects multiply on top rather than replacing it: being slowed while
        // mid-swing should be slower than either alone, and treating them as separate
        // caps would let the larger one hide the other.
        const swing = 1 - 0.80 * this.swingBlend;
        const maxSpeed = (input.sprint ? RUN_SPEED : WALK_SPEED) * swing * this.moveScale;

        _wish.set(
            _fwd.x * input.moveZ + _right.x * input.moveX,
            0,
            _fwd.z * input.moveZ + _right.z * input.moveX
        );

        const wishLen = Math.hypot(_wish.x, _wish.z);
        if (wishLen > 0.001) {
            _wish.x = (_wish.x / wishLen) * maxSpeed;
            _wish.z = (_wish.z / wishLen) * maxSpeed;

            const a = WALK_ACCEL * h;
            this.velocity.x += Scalar.Clamp(_wish.x - this.velocity.x, -a, a);
            this.velocity.z += Scalar.Clamp(_wish.z - this.velocity.z, -a, a);

            // Face the direction of travel, eased — unless something has given us a
            // direction to hold instead, which is how a character strafes while
            // pointed at a target.
            const want = input.faceYaw === null || input.faceYaw === undefined
                ? Math.atan2(_wish.x, _wish.z)
                : input.faceYaw;
            this.facing = angleDamp(this.facing, want, TURN_RATE, h);
        } else {
            if (input.faceYaw !== null && input.faceYaw !== undefined) {
                this.facing = angleDamp(this.facing, input.faceYaw, TURN_RATE, h);
            }
            const d = WALK_DECEL * h;
            const s = Math.hypot(this.velocity.x, this.velocity.z);
            if (s > 0.0001) {
                const k = Math.max(0, s - d) / s;
                this.velocity.x *= k;
                this.velocity.z *= k;
            }
        }
    }

    _surfStep(h, rig) {
        const input = this.intent;
        // Steer from the mouse (camera yaw drift) plus explicit A/D.
        const steer = Scalar.Clamp(
            input.moveX * 0.85 + angleDelta(this.facing, rig.yaw) * 1.25,
            -1,
            1
        );
        this.facing += steer * SURF_TURN * h;

        // Camera shake, and only from the one thing that earns it: an edge
        // loaded up at speed. Added as a rate rather than as an impulse, so it
        // reaches an equilibrium against the rig's own decay — hard carve at top
        // speed settles around 0.4 trauma, which is a couple of centimetres of
        // rig movement. Anything you can consciously see here is too much.
        const load = Math.abs(steer) * (this.speed / SURF_MAX);
        if (load > 0.25) rig.addTrauma((load - 0.25) * 1.35 * h);

        const fx = Math.sin(this.facing);
        const fz = Math.cos(this.facing);

        // Gravity along the surface, in the fall line.
        //
        // This is a *vector* down the slope rather than a scalar added to the rider's
        // forward thrust, and it is worth being explicit about why, because the scalar
        // form is what made surfing feel broken.
        //
        // It used to read `-(n.x*fx + n.z*fz) * 26`, added straight into `thrust`. Two
        // things were wrong with that. The sign was inverted — the surface normal leans
        // in the direction the ground descends, so a rider pointed downhill scored a
        // *negative* assist: on a 27 degree slope, facing down the fall line produced
        // -3.1 m/s^2 and drove them backwards, while facing uphill produced +20.1 and
        // fired them up the mountain. And because it landed in `thrust`, terrain could
        // flip the rider's own drive negative, which no amount of leg strength does.
        //
        // As a vector it cannot do either. Gravity pulls downhill because that is where
        // downhill is; the rider's thrust is a separate, forward-only term. A traverse
        // now gets tugged toward the fall line, which is both correct and the thing that
        // makes holding a line across a face feel like work.
        this.terrain.normalAt(this.position.x, this.position.z, _n);
        const grade = Math.hypot(_n.x, _n.z); // = sin of the slope angle
        if (grade > 1e-4) {
            const pull = SURF_GRAVITY * grade * h;
            this.velocity.x += (_n.x / grade) * pull;
            this.velocity.z += (_n.z / grade) * pull;
        }

        // The rider's own drive: forward, or nothing. A board has no reverse, so this
        // term is never allowed to go negative — the brake below works by taking speed
        // out rather than by pushing the other way.
        let thrust = SURF_THRUST;
        // A buried board does not drive. This is most of why a landing costs
        // anything at all beyond the frame it happens on.
        thrust *= (1 - PLOW_THRUST_LOSS * this.plow) * this.moveScale;

        this.velocity.x += fx * thrust * h;
        this.velocity.z += fz * thrust * h;

        // Lateral grip: kill sideways velocity, but not entirely — the residual
        // is what reads as a drift when you overcook the turn.
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        const lat = this.velocity.x * rx + this.velocity.z * rz;
        const grip = Math.min(1, SURF_GRIP * h);
        this.velocity.x -= rx * lat * grip;
        this.velocity.z -= rz * lat * grip;

        // Quadratic drag → a natural terminal speed, plus whatever snow the board
        // is currently ploughing through, plus the brake if it is being asked for.
        const s = Math.hypot(this.velocity.x, this.velocity.z);
        if (s > 0.0001) {
            // Braking is drag, not reverse thrust. Pulling back used to subtract 14 from
            // a base of 8.5, so holding it on flat ground produced -5.5 m/s^2 and the
            // rider accelerated backwards; taking it out of the speed instead cannot do
            // that, because the scale factor below is clamped at zero.
            const brake = input.moveZ < 0 ? SURF_BRAKE : 0;

            // Ploughing resistance scales with speed, because that is what ploughing is:
            // snow has to be moving out of the way for it to cost anything. As a constant
            // it made starting from a standstill impossible — a fully buried board had
            // 2.55 m/s^2 of drive against 3.40 of drag, a net -0.85, so the answer to
            // "press surf after a heavy landing" was that nothing happened at all.
            const plowDrag = PLOW_DRAG * this.plow * Math.min(1, s / PLOW_DRAG_SPEED);

            const drag = SURF_DRAG * s * s * 0.02 + 0.9 + plowDrag + brake;
            const k = Math.max(0, s - drag * h) / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
        if (s > SURF_MAX) {
            const k = SURF_MAX / s;
            this.velocity.x *= k;
            this.velocity.z *= k;
        }
    }

    /**
     * Distance-driven gait. Phase advances with ground travelled, not with time,
     * which is what keeps feet planted instead of sliding.
     */
    _gait(h) {
        this.footfall = false;

        // Feet stay on the board while surfing — and for the run-out afterwards.
        //
        // The surf blend eases to zero in a fifth of a second, but the momentum
        // takes two thirds of one to bleed off, and in between the character is
        // travelling at nineteen metres a second. The gait is distance-driven, so
        // it answered that with a twelve-hertz cadence and the legs blurred. A
        // sprint is the fastest thing anyone walks at; above it, glide.
        //
        // Airborne is the third exclusion: feet that keep striding through a
        // jump are the single most obvious tell that a jump was bolted on.
        this.stepping = this.surf <= 0.5 && this.speed <= RUN_SPEED * 1.2 && !this.airborne;
        if (!this.stepping) {
            this.gaitPhase = 0;
            return;
        }

        const dist = this.speed * h;
        const stride = STRIDE_REST + STRIDE_PER_SPEED * this.speed;
        this.strideLength = stride;
        const prev = this.gaitPhase;
        this.gaitPhase = (this.gaitPhase + dist / stride) % 1;

        if (this.speed < 0.15) return;

        // Two plants per cycle, at phase 0.0 and 0.5.
        const crossed =
            (prev < 0.5 && this.gaitPhase >= 0.5) || this.gaitPhase < prev;
        if (!crossed) return;

        this.footfall = true;
        this.footIndex = this.gaitPhase < 0.5 ? 0 : 1;
        this.footImpact = Scalar.Clamp(0.35 + this.speed / RUN_SPEED, 0, 1.3);

        // Offset the plant to the correct side of the body.
        const side = this.footIndex === 0 ? -0.17 : 0.17;
        const rx = Math.cos(this.facing);
        const rz = -Math.sin(this.facing);
        this.footPos.set(
            this.position.x + rx * side,
            this.position.y,
            this.position.z + rz * side
        );
    }
}

// ------------------------------------------------------------------ helpers

/** Shortest signed delta from a to b, wrapped to [-PI, PI]. */
export function angleDelta(a, b) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return d;
}

/** Framerate-independent easing across the shortest arc. */
export function angleDamp(cur, target, rate, dt) {
    return cur + angleDelta(cur, target) * (1 - Math.exp(-rate * dt));
}
