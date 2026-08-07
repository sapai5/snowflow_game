/**
 * The figure — skeleton, bind pose, and the procedural locomotion that poses it.
 *
 * There is no rig file and no animation data. Everything here is solved from the
 * motion state the controller already produces. The one thing that buys has to
 * be paid for in exchange: **feet plant rather than slide**.
 *
 * Planting is not approximated. When a foot enters stance its world position is
 * recorded and then held absolutely fixed while the body travels over it; the
 * leg is solved by two-bone IK to reach that fixed point. A foot in this rig
 * cannot slide, because during stance nothing in the code is capable of moving
 * it. The gait phase itself is driven by distance travelled, not by a clock, so
 * the stride length and the ground speed are the same number by construction.
 *
 * Bone convention: a bone's local +Y runs from its own joint toward its child,
 * so a hanging arm has +Y pointing at the floor. Geometry is authored in
 * bind-pose world space and skinned by `world * inverseBind`.
 *
 * Allocation: none per frame. Everything lives in flat arrays sized at
 * construction.
 */

import { setFrameFromDir, invertRigid, mul, xformPoint } from "../core/mat4.js";

// --------------------------------------------------------------- bone indices
export const B_ROOT = 0;
export const B_SPINE = 1;
export const B_CHEST = 2;
export const B_NECK = 3;
export const B_HEAD = 4;
export const B_HOOD = 5;
export const B_UPPER_L = 6;
export const B_FORE_L = 7;
export const B_HAND_L = 8;
export const B_UPPER_R = 9;
export const B_FORE_R = 10;
export const B_HAND_R = 11;
export const B_THIGH_L = 12;
export const B_SHIN_L = 13;
export const B_FOOT_L = 14;
export const B_THIGH_R = 15;
export const B_SHIN_R = 16;
export const B_FOOT_R = 17;
export const BONE_COUNT = 18;

/**
 * Bind pose, nine floats per bone: joint position, bone direction, front
 * reference. A 1.79 m figure with the pelvis at 0.95 — deliberately a little
 * long in the leg and narrow in the shoulder, because the silhouette is read at
 * fifteen metres through a robe and slightly heroic proportions survive that
 * better than accurate ones.
 */
const BIND = new Float32Array([
    /* ROOT    */ 0, 0.95, 0, 0, 1, 0, 0, 0, 1,
    /* SPINE   */ 0, 1.06, 0, 0, 1, 0, 0, 0, 1,
    /* CHEST   */ 0, 1.26, 0, 0, 1, 0, 0, 0, 1,
    /* NECK    */ 0, 1.46, 0, 0, 1, 0, 0, 0, 1,
    /* HEAD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,
    /* HOOD    */ 0, 1.55, 0, 0, 1, 0, 0, 0, 1,

    /* UPPER_L */ -0.185, 1.400, 0.000, -0.16, -0.987, 0, 0, 0, 1,
    /* FORE_L  */ -0.230, 1.123, 0.000, -0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_L  */ -0.243, 0.866, 0.016, -0.02, -0.992, 0.12, 0, 0, 1,
    /* UPPER_R */ 0.185, 1.400, 0.000, 0.16, -0.987, 0, 0, 0, 1,
    /* FORE_R  */ 0.230, 1.123, 0.000, 0.05, -0.997, 0.06, 0, 0, 1,
    /* HAND_R  */ 0.243, 0.866, 0.016, 0.02, -0.992, 0.12, 0, 0, 1,

    /* THIGH_L */ -0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_L  */ -0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_L  */ -0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
    /* THIGH_R */ 0.100, 0.900, 0, 0, -1, 0, 0, 0, 1,
    /* SHIN_R  */ 0.100, 0.460, 0, 0, -1, 0, 0, 0, 1,
    /* FOOT_R  */ 0.100, 0.090, 0, 0, 0, 1, 0, 1, 0,
]);

/** Segment lengths implied by the bind table, metres. */
const THIGH_LEN = 0.44;
const SHIN_LEN = 0.37;
const UPPER_LEN = 0.28;
const FORE_LEN = 0.26;

/** Pelvis height above the feet in the bind pose. */
const HIP_HEIGHT = 0.95;

// ------------------------------------------------------- module-scope scratch
const _axes = new Float32Array(9);   // X, Y, Z of a composed basis
const _p = new Float32Array(6);
const _knee = new Float32Array(6);
const _hip = new Float32Array(3);
const _sh = new Float32Array(3);
/** Scratch for `rodrigues`. */
const _rv = new Float32Array(3);

/**
 * Height above the pelvis that a tucked body rotates about, metres.
 *
 * Roughly the centre of mass of a person with their knees up. Rotating about the
 * pelvis itself throws the head through a much larger circle than it should
 * travel, and the flip reads as being swung on a rope.
 */
const FLIP_PIVOT_Y = 0.22;

/**
 * Ankle roll through a step, radians.
 *
 * `HEEL_STRIKE` is how far the toe is held up as the foot reaches for the ground
 * — about nine degrees, which is what a walking foot does — and `TOE_OFF` is how
 * far it points as the heel drives up off the back of the step. The pair of them
 * is the single cheapest cue that a figure is walking rather than gliding: a sole
 * held parallel to the ground for the whole cycle is a mannequin on rails, and
 * the eye catches it immediately even when it cannot say why.
 */
const HEEL_STRIKE = 0.16;
const TOE_OFF = 0.46;

/**
 * How far from the shoulder the hand travels during a swing, metres, and how much
 * further it reaches at the middle of the sweep.
 *
 * The extension is the difference between a fencer and a batter. A bat swing is
 * not a fixed-radius sweep: the arms fold on the wind-up, extend hard through
 * contact and fold again on the follow-through, and the reach at impact is what
 * puts the tip somewhere the body could not have put it any other way.
 */
const SWING_REACH = 0.42;
const SWING_EXTEND = 0.10;

/**
 * How far down the handle the off hand takes hold, metres.
 *
 * A hand's width below the sword hand. Both hands at the same point is a clasp rather
 * than a grip, and the grip is only 21 cm long in total — see `GUARD_TOP` in `sword.js` —
 * so there is not much room to be wrong in either direction.
 */
const GRIP_DROP = 0.115;

/** Scratch for `swingDirection` and its two de Casteljau intermediates. */
const _sd = new Float32Array(3);
const _c0 = new Float32Array(3);
const _c1 = new Float32Array(3);
/**
 * Time scale for everything sprung while a hit-stop is running. Must match
 * `HITSTOP_RATE` in `swordCombat.js` — the phase clock and the springs chasing it
 * have to slow by the same factor or the chain unwinds during contact.
 */
const HITSTOP_RATE = 0.35;

/**
 * The lag chain's springs: chest, shoulders, hand.
 *
 * Each is stiffer than the link it drives, and each is underdamped — around 0.55
 * of critical — so the sequence is hips, chest, shoulders, hand, with every link
 * overshooting the one before it and settling behind it.
 *
 * These were retuned upward when the strike became exponential. Peak angular rate
 * at the end of the sweep is about three and a half times the average, and a chain
 * soft enough to lag pleasantly behind a constant-speed sweep simply gives up in
 * front of an accelerating one: the hips finish, the chest is still halfway, and
 * the arm arrives after the attack is notionally over. Stiff and underdamped is
 * the combination that keeps the sequencing legible while still cracking.
 */
const CHEST_K = 3600;
const CHEST_C = 68;
const SHOULDER_K = 2600;
const SHOULDER_C = 56;
const HAND_K = 1700;
const HAND_C = 44;

/**
 * The 3D hand spring. Softer than the scalar chain and *less* damped (ζ ≈ 0.55),
 * because its overshoot happens in space rather than in phase: this is the one
 * that swings wide.
 */
const ARM_K = 950;
const ARM_C = 34;

/**
 * Where the hands travel during each attack, in degrees, in the chest's own frame.
 *
 * **This is the table to edit to change an arc.** For the sword hand, two
 * spherical angles per end of the sweep plus a bow:
 *
 *   yaw   rotation about the body's up axis. 0 is straight ahead, positive is to
 *         the character's right, past ±90 is behind them. This decides how wide the
 *         swing is.
 *   elev  elevation off the horizontal, positive up. This decides whether it is a
 *         chop, a level cut or a rising slash.
 *   bow   how far the *middle* of the sweep is pushed off the shortest path,
 *         degrees. This is what makes the swing an arc rather than a straight
 *         line: the shortest path between two directions is a great circle, and a
 *         great circle seen roughly edge-on is a straight sweep. A real arm cannot
 *         travel one anyway — the elbow drives the hand out and forward through the
 *         middle of a cut — so the path bulges, and this is that bulge.
 *
 *   viaYaw/viaElev  optional, and it replaces `bow`: the midpoint stated outright.
 *         Needed whenever an arc's two ends are far enough apart in yaw that the
 *         *shortest* path is not the intended one. The heavy finisher is exactly
 *         that case — from high-left to low-right past the far hip is 193 degrees
 *         the way a body swings it and 167 the other way, so left to itself the
 *         interpolation took the short route: up over the head and around behind.
 *         Stating the via puts the path back through the front where the cut is,
 *         and because the curve passes through it the route is then unambiguous.
 *
 * Only the sword hand is in this table. The off arm takes no part in a swing: the
 * two arms have separate jobs — the right one fights, the left one casts — and the
 * off arm's only motion of its own is the ordinary locomotion swing and the spell
 * stance. It is not stationary in *world* space during an attack, because the chest
 * rotates up to 90 degrees and the shoulders are built on the chest frame, so it is
 * carried around with the trunk and its own spring gives it a trail. That is the
 * whole of its involvement, and it is enough: an authored counter-sweep on top of
 * a trunk that is already counter-rotating is what produced arms visibly fighting
 * each other.
 *
 * The string is designed end-to-start, and the numbers say so: each stroke's coil
 * sits where the previous stroke's follow-through left the blade, so chaining
 * loads every swing out of the last one's overrotation instead of rewinding from
 * neutral. Slash 1 ends low-right (~+95° after overshoot) — the return stroke
 * coils at +92°. The return ends high-left (~-95°) — the finisher coils at -98°.
 * That continuity is the combo.
 */
const SWING_ARCS = [
    null,
    {
        // 1 — Quick Slash. A forehand descending diagonal: high on the sword side,
        // down across the centre to the off hip.
        //
        // This used to run the other way — coiled high-*left* and cut to the right —
        // which is a backhand, and a backhand is the one stroke a right shoulder cannot
        // start comfortably: getting the hand high and across the chest needs adduction
        // and internal rotation at the same time, and the arm has to route somewhere.
        // The forehand is the stroke the joint is built for, so it is the one the fast
        // attack uses.
        hand: { fromYaw: 46, fromElev: 34, toYaw: -40, toElev: -26, bow: 22 },
    },
    {
        // 2 — the Heavy Finisher. A vertical overhead cut: the hand raised above the head
        // on the sword side, then driven straight down the centre line to below the belt.
        //
        // Two things were wrong with what this was, and they had to be fixed together.
        //
        // The coil was at yaw -98, elevation +46 — up and ninety-eight degrees across the
        // body. A right arm cannot go there. Two-bone IK does not fail on an unreachable
        // *attitude*, though; it only fails on an unreachable distance, so it returned a
        // pose, and the pose it returned was the arm wrapping over the head. That is what
        // this looked like in play.
        //
        // Moving the coil to the sword side fixed the arm and broke the string: a
        // descending cut from high-right to low-left is the jab's plane, and the finisher
        // would have been the same stroke twice, slower. So this is vertical rather than
        // diagonal — twenty degrees of yaw against a hundred and twenty of elevation,
        // straight down the middle. That is also the heaviest cut a shoulder can throw,
        // because the whole arc is in the plane the joint flexes through, and it is the
        // one plane the two light strokes leave unused.
        //
        // The via sits forward and low of the direct path, which brings the blade down in
        // *front* of the body rather than through it — the spherical interpolation between
        // two nearly antipodal directions is otherwise free to take either side.
        //
        // The coil sits at 64 degrees rather than the 76 it started at. Overhead is where
        // a heavy cut loads, but a hand directly above the head is a *hold* — the blade has
        // to come back down through the same space it went up through, and the top of the
        // arc reads as a pause. Two hands on the grip also physically cannot go that high
        // without the off shoulder following, and the off shoulder is attached to a trunk
        // that is doing something else. Sixty-four degrees still clears the head and leaves
        // the descent room to accelerate.
        hand: { fromYaw: 20, fromElev: 64, toYaw: -4, toElev: -44, viaYaw: 6, viaElev: 26 },
    },
    {
        // 3 — the Return Slash. The mirror of the jab: coiled low across the body where
        // the jab's follow-through left it, rising back out along the opposite diagonal
        // to high on the sword side.
        //
        // Rising and outward, so it is abduction and external rotation — the strongest
        // and freest direction a shoulder has. Slightly wider than the jab, because the
        // string escalates.
        hand: { fromYaw: -44, fromElev: -28, toYaw: 58, toElev: 30, bow: 26 },
    },
];

/**
 * The shoulder's envelope, in the body frame, for the sword arm.
 *
 * Two-bone IK will solve for any target within reach, including targets a shoulder
 * cannot present a hand to — it has no concept of a joint limit, so an impossible target
 * does not fail, it returns a pose that is merely wrong. Every odd-looking arm in this
 * game has come from exactly that, and the fix is to make the impossible target
 * unreachable rather than to keep correcting the poses it produces.
 *
 * The numbers are the useful range of a shoulder with the torso held still, which is
 * narrower than the anatomical maximum because reaching the extremes needs the spine and
 * the scapula and the figure's trunk is already doing its own thing:
 *
 *   elevation   about 78 degrees down to 96 up. Past 96 the hand is behind the vertical
 *               and therefore behind the head, which is precisely the artefact this
 *               exists to prevent.
 *   crossing    the arm crosses the midline furthest when it is low — a hand can reach
 *               the opposite hip easily and the opposite ear not at all. So the inward
 *               limit tightens as the arm rises: 58 degrees past centre at shoulder
 *               height, only 12 overhead.
 *   behind      extension backward shrinks the same way and for the same reason, from
 *               122 degrees at shoulder height to 78 overhead.
 *
 * Applied to the authored endpoints when the table is built, and again to the final
 * direction each frame — the follow-through *extrapolates* past the end of the arc, so
 * the endpoints being legal is not sufficient on its own.
 */
const SH_ELEV_MIN = -78;
const SH_ELEV_MAX = 96;

function shoulderYawRange(elevDeg, out) {
    const rise = Math.max(0, elevDeg) / 90;
    const drop = Math.max(0, -elevDeg) / 90;
    // Low and across is easy; high and across is not.
    out[0] = -58 + 46 * rise - 24 * drop;
    out[1] = 122 - 44 * rise - 18 * drop;
    return out;
}

const _range = [0, 0];

/**
 * Clamp a pair of authored angles into the envelope.
 *
 * @returns {[number, number]} yaw, elevation, both in degrees
 */
function clampShoulderAngles(yawDeg, elevDeg) {
    const e = clamp(elevDeg, SH_ELEV_MIN, SH_ELEV_MAX);
    shoulderYawRange(e, _range);
    return [clamp(yawDeg, _range[0], _range[1]), e];
}

/**
 * Clamp a unit direction into the envelope, in place.
 *
 * Four transcendentals, and only while a swing is running. The alternative — building the
 * limit into the interpolation itself — would mean the arc no longer passes through the
 * angles it was authored with, which is worse: an arc would then mean something different
 * depending on where it sat in the envelope.
 *
 * @param {number[]} d unit direction, body frame: x right, y up, z forward
 */
function clampShoulderDir(d) {
    const elev = (Math.asin(clamp(d[1], -1, 1)) * 180) / Math.PI;
    const yaw = (Math.atan2(d[0], d[2]) * 180) / Math.PI;
    const e = clamp(elev, SH_ELEV_MIN, SH_ELEV_MAX);
    shoulderYawRange(e, _range);
    const y = clamp(yaw, _range[0], _range[1]);
    if (y === yaw && e === elev) return d;
    const er = (e * Math.PI) / 180;
    const yr = (y * Math.PI) / 180;
    const ce = Math.cos(er);
    d[0] = ce * Math.sin(yr);
    d[1] = Math.sin(er);
    d[2] = ce * Math.cos(yr);
    return d;
}

/**
 * The arcs above, precomputed: the sword hand's sweep as three unit control
 * directions for a spherical quadratic Bézier, plus which way the sweep turns.
 *
 * Angles between local directions are basis-independent, so everything the
 * interpolation needs except the final blend is solved once, here.
 *
 * `turn` is the sign of the yaw sweep, and the trunk, the lean and the head all
 * take their direction from it rather than from a hard-coded per-attack sign. Edit
 * an arc to sweep the other way and the body follows it.
 */
const SWING_SLERP = SWING_ARCS.map((entry) => {
    if (!entry) return null;
    const h = entry.hand;
    // Through the envelope on the way in, so an arc cannot be authored outside it. This
    // is a build-time clamp on three angle pairs; it costs nothing and it means the
    // numbers in the table above are the intent rather than the truth.
    const from = clampShoulderAngles(h.fromYaw, h.fromElev);
    const to = clampShoulderAngles(h.toYaw, h.toElev);
    const a = dirFromAngles(from[0], from[1]);
    const b = dirFromAngles(to[0], to[1]);
    const via = h.viaYaw === undefined
        ? bowedMidpoint(a, b, ((h.bow || 0) * Math.PI) / 180)
        : (() => {
            const v = clampShoulderAngles(h.viaYaw, h.viaElev);
            return dirFromAngles(v[0], v[1]);
        })();
    const pair = (p, q) => {
        const cos = clamp(p[0] * q[0] + p[1] * q[1] + p[2] * q[2], -1, 1);
        const theta = Math.acos(cos);
        return { theta, sin: Math.sin(theta) };
    };
    return {
        a, via, b,
        av: pair(a, via),
        vb: pair(via, b),
        turn: Math.sign(h.toYaw - h.fromYaw) || 1,
    };
});

/** (yaw, elevation) in degrees to a unit (right, up, forward) triple. */
function dirFromAngles(yawDeg, elevDeg) {
    const y = (yawDeg * Math.PI) / 180;
    const e = (elevDeg * Math.PI) / 180;
    const ce = Math.cos(e);
    return [ce * Math.sin(y), Math.sin(e), ce * Math.cos(y)];
}

/**
 * The great-circle midpoint of `a` and `b`, rotated off that circle by `bow`.
 *
 * Rotating about the chord through the two ends is what moves the midpoint out of
 * their plane while leaving the ends untouched, so the path bulges and still
 * arrives exactly where it was authored to.
 *
 * The sign is chosen rather than specified: whichever direction pushes the
 * midpoint *forward* wins, because that is the way an arm bows — the elbow leads
 * the hand out in front of the chest through the middle of a cut, on every arc, in
 * both directions. Solving it here means a new arc cannot be authored with its bow
 * inside out.
 */
function bowedMidpoint(a, b, bow) {
    let mx = a[0] + b[0];
    let my = a[1] + b[1];
    let mz = a[2] + b[2];
    let ml = Math.hypot(mx, my, mz);
    // Diametrically opposed ends have no unique midpoint; nothing in the table is
    // close to that, and the guard costs one branch.
    if (ml < 1e-4) return [a[0], a[1], a[2]];
    mx /= ml; my /= ml; mz /= ml;
    if (bow === 0) return [mx, my, mz];

    let cx = b[0] - a[0];
    let cy = b[1] - a[1];
    let cz = b[2] - a[2];
    const cl = Math.hypot(cx, cy, cz) || 1;
    cx /= cl; cy /= cl; cz /= cl;

    const rot = (angle) => {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1 - c;
        const d = cx * mx + cy * my + cz * mz;
        return [
            mx * c + (cy * mz - cz * my) * s + cx * d * t,
            my * c + (cz * mx - cx * mz) * s + cy * d * t,
            mz * c + (cx * my - cy * mx) * s + cz * d * t,
        ];
    };
    const plus = rot(bow);
    const minus = rot(-bow);
    return plus[2] >= minus[2] ? plus : minus;
}

/** Which way an attack's sweep turns: +1 to the character's right, -1 to the left. */
function swingTurn(plane) {
    const s = SWING_SLERP[plane];
    return s ? s.turn : 1;
}

/** Slerp two unit vectors into `out`, given their precomputed angle. */
function slerpInto(out, p, q, theta, sinT, s) {
    if (sinT < 1e-4) {
        out[0] = p[0] + (q[0] - p[0]) * s;
        out[1] = p[1] + (q[1] - p[1]) * s;
        out[2] = p[2] + (q[2] - p[2]) * s;
        return;
    }
    const w0 = Math.sin((1 - s) * theta) / sinT;
    const w1 = Math.sin(s * theta) / sinT;
    out[0] = p[0] * w0 + q[0] * w1;
    out[1] = p[1] * w0 + q[1] * w1;
    out[2] = p[2] * w0 + q[2] * w1;
}

/**
 * Direction from the shoulder to the hand, part way through an attack.
 *
 * The sword hand rides a **spherical quadratic Bézier** — de Casteljau with slerp,
 * across the two ends and the bowed midpoint. Three interpolations instead of one,
 * and the difference is the whole complaint about the swing looking straight: a
 * single slerp is the *shortest* path between two directions, which is exactly the
 * path an arm cannot take. With a control point off that path the hand sweeps a
 * curve that leads out through the middle of the cut and comes back for the finish,
 * which is what a shoulder and an elbow together actually describe.
 *
 * `s` is deliberately allowed outside 0..1: every step of the construction
 * extrapolates, so the follow-through continues the curve past the target line
 * rather than stopping dead at it.
 *
 * Writes into `_sd`.
 */
/**
 * The sweep in the *body's* frame, before any basis is applied.
 *
 * Split out because matching one plane's direction against another's is
 * basis-independent — the arcs are authored in this frame — so the arc-matching below
 * needs no character, no chest orientation and no world at all.
 *
 * @param {number} plane
 * @param {number} s 0..1 along the sweep; outside that it extrapolates, which is used
 * @param {number[]} out
 * @param {number[]} c0 scratch
 * @param {number[]} c1 scratch
 */
function swingLocal(plane, s, out, c0, c1) {
    const e = SWING_SLERP[plane];
    if (!e) return out;
    slerpInto(c0, e.a, e.via, e.av.theta, e.av.sin, s);
    slerpInto(c1, e.via, e.b, e.vb.theta, e.vb.sin, s);
    const cos = clamp(c0[0] * c1[0] + c0[1] * c1[1] + c0[2] * c1[2], -1, 1);
    const theta = Math.acos(cos);
    slerpInto(out, c0, c1, theta, Math.sin(theta), s);
    return out;
}

const _m0 = [0, 0, 0];
const _m1 = [0, 0, 0];
const _mc0 = [0, 0, 0];
const _mc1 = [0, 0, 0];

/**
 * The sweep, in world space, with the chain bridge applied.
 *
 * `bridge` is how much of a chained wind-up is left to travel, 1 at its first frame and 0
 * at its last. While it is non-zero the direction is interpolated *between planes*: from
 * where the previous stroke actually left the blade, to where this stroke's coil is.
 *
 * This is the fix for the blade stopping mid-combo, and it took two wrong answers to get
 * to. The rebase assumed a stroke's follow-through and the next stroke's coil were the same
 * world direction — the arcs are authored end-to-start, so it is nearly true for the jab
 * into the return stroke and 66 degrees out for the return stroke into the finisher. It
 * relabelled the arc as -1, the coil, which had two consequences: the hand jumped by
 * whatever the two directions differed by, and the wind-up then interpolated from -1 to -1
 * and did not move the blade *at all* for its whole duration. Fifteen frames of a
 * completely stationary blade before the finisher, at 30 fps.
 *
 * The first attempt was to start the wind-up further along the new sweep, which gave it
 * something to travel through but made the jump worse. The second was to *measure* the
 * nearest matching arc, which reduced the jump by five degrees and no more, because the
 * blade's direction is simply not on the new plane's great circle at any parameter.
 *
 * Bridging is exact at both ends by construction: at the first frame the direction is
 * precisely where the blade was, at the last it is precisely the coil, and in between it is
 * a great-circle path between them. There is no jump to smooth and no hold to sit through —
 * the whole 66 degrees becomes wind-up travel, which is what a backswing is.
 */
export function swingSweepLocal(plane, s, out, bridge, fromPlane, fromArc) {
    if (!SWING_SLERP[plane]) return out;
    swingLocal(plane, s, out, _c0, _c1);

    if (bridge > 0.001 && fromPlane > 0 && SWING_SLERP[fromPlane]) {
        swingLocal(fromPlane, (fromArc + 1) * 0.5, _m0, _mc0, _mc1);
        const cosb = clamp(
            out[0] * _m0[0] + out[1] * _m0[1] + out[2] * _m0[2], -1, 1
        );
        const thetab = Math.acos(cosb);
        const sinb = Math.sin(thetab);
        // Toward where the blade was, by however much of the wind-up is left.
        if (sinb > 1e-5) slerpInto(out, out, _m0, thetab, sinb, bridge);
    }
    return out;
}

function swingDirection(
    plane, s, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ,
    bridge, fromPlane, fromArc
) {
    if (!SWING_SLERP[plane]) return;
    swingSweepLocal(plane, s, _sd, bridge, fromPlane, fromArc);

    // Into the envelope while still in the body frame, which is the only frame the limits
    // mean anything in. This is here as well as at table-build time because `s` runs past
    // 1 during the follow-through: the arc *extrapolates* beyond its authored end, so
    // legal endpoints do not make the whole path legal. The old finisher overshot 45
    // degrees past a target that was already outside the joint.
    clampShoulderDir(_sd);

    const wx = _sd[0];
    const wy = _sd[1];
    const wz = _sd[2];

    // Into world space, through the chest's basis.
    const dx = rX * wx + uX * wy + fX * wz;
    const dy = rY * wx + uY * wy + fY * wz;
    const dz = rZ * wx + uZ * wy + fZ * wz;
    const l = Math.hypot(dx, dy, dz) || 1;
    _sd[0] = dx / l;
    _sd[1] = dy / l;
    _sd[2] = dz / l;
}

/**
 * Rotate a vector about a unit axis. Rodrigues, with cos/sin/1-cos passed in
 * because every call in a body rotation shares the same angle.
 *
 * Result lands in `_rv`.
 */
function rodrigues(x, y, z, ax, ay, az, c, s, t) {
    const dot = ax * x + ay * y + az * z;
    _rv[0] = x * c + (ay * z - az * y) * s + ax * dot * t;
    _rv[1] = y * c + (az * x - ax * z) * s + ay * dot * t;
    _rv[2] = z * c + (ax * y - ay * x) * s + az * dot * t;
}

/**
 * Compose an orthonormal basis from yaw, then pitch about its own right axis,
 * then roll about its own forward axis. Writes X, Y, Z into `_axes`.
 *
 * Positive pitch leans forward, positive roll tips the head to the character's
 * right — which is the sign the controller's `lean` already uses.
 */
function composeBasis(yaw, pitch, roll) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw);
    let xx = cy, xy = 0, xz = -sy;
    let yx = 0, yy = 1, yz = 0;
    let zx = sy, zy = 0, zz = cy;

    if (pitch !== 0) {
        const c = Math.cos(pitch), s = Math.sin(pitch);
        const nyx = yx * c + zx * s, nyy = yy * c + zy * s, nyz = yz * c + zz * s;
        const nzx = zx * c - yx * s, nzy = zy * c - yy * s, nzz = zz * c - yz * s;
        yx = nyx; yy = nyy; yz = nyz; zx = nzx; zy = nzy; zz = nzz;
    }
    if (roll !== 0) {
        const c = Math.cos(roll), s = Math.sin(roll);
        const nxx = xx * c - yx * s, nxy = xy * c - yy * s, nxz = xz * c - yz * s;
        const nyx = yx * c + xx * s, nyy = yy * c + xy * s, nyz = yz * c + xz * s;
        xx = nxx; xy = nxy; xz = nxz; yx = nyx; yy = nyy; yz = nyz;
    }

    _axes[0] = xx; _axes[1] = xy; _axes[2] = xz;
    _axes[3] = yx; _axes[4] = yy; _axes[5] = yz;
    _axes[6] = zx; _axes[7] = zy; _axes[8] = zz;
}

/**
 * Two-bone IK. Given a root joint, an end target and a pole direction, writes
 * the middle joint's world position into `out[0..2]` and the end position it
 * actually solved for into `out[3..5]`.
 *
 * The target is pulled inside reach rather than clamped at it: a fully extended
 * leg reads as a stiff peg, and the last centimetre of reach is where all the
 * knee-lock artefacts live.
 *
 * The solved end position matters as much as the knee. A stride at five and a
 * half metres a second asks for a foot a metre in front of a hip with eighty
 * centimetres of leg between them, and the honest answer to that is "no": if the
 * caller poses the shin at the raw target anyway, the limb skins visibly
 * stretched, which is the single most obvious tell that a rig is procedural. The
 * foot lagging its plant by a few centimetres at the extremes of a sprint is a
 * much cheaper lie than a rubber shin.
 */
function solveTwoBone(rx, ry, rz, tx, ty, tz, px, py, pz, l1, l2, out) {
    let dx = tx - rx, dy = ty - ry, dz = tz - rz;
    let dist = Math.hypot(dx, dy, dz);
    const maxReach = (l1 + l2) * 0.995;
    if (dist < 1e-4) { dx = 0; dy = -1; dz = 0; dist = 1e-4; }
    if (dist > maxReach) dist = maxReach;
    const inv = 1 / Math.hypot(dx, dy, dz);
    dx *= inv; dy *= inv; dz *= inv;

    // Cosine rule: how far along the root→target axis the middle joint projects.
    const a = (l1 * l1 - l2 * l2 + dist * dist) / (2 * dist);
    const h = Math.sqrt(Math.max(0, l1 * l1 - a * a));

    // Pole, orthogonalised against the axis — this is what decides which way the
    // knee or elbow bends, and it has to be re-derived every frame because the
    // axis swings through it during a stride.
    const d = px * dx + py * dy + pz * dz;
    let ox = px - dx * d, oy = py - dy * d, oz = pz - dz * d;
    let ol = Math.hypot(ox, oy, oz);
    if (ol < 1e-3) {
        // The pole is parallel to the limb, so it says nothing about which way the joint
        // bends. Fall back to *any* vector perpendicular to the axis, built by crossing
        // with whichever cardinal is least aligned with it — that choice is what keeps
        // the cross product from being degenerate in turn.
        //
        // This used to be world +z, which is wrong for a character facing any other way,
        // and it was reachable: a hand raised overhead gives a vertical limb axis, and the
        // elbow pole that drove it was also vertical. The pole is kept lateral for a
        // raised arm now, so this is a net rather than a code path — but a net that
        // returns a wrong-facing elbow is not much of one.
        const ax = Math.abs(dx), ay = Math.abs(dy), az = Math.abs(dz);
        let sx = 0, sy = 0, sz = 0;
        if (ax <= ay && ax <= az) sx = 1;
        else if (ay <= az) sy = 1;
        else sz = 1;
        ox = sy * dz - sz * dy;
        oy = sz * dx - sx * dz;
        oz = sx * dy - sy * dx;
        ol = Math.hypot(ox, oy, oz) || 1;
    }
    ox /= ol; oy /= ol; oz /= ol;

    out[0] = rx + dx * a + ox * h;
    out[1] = ry + dy * a + oy * h;
    out[2] = rz + dz * a + oz * h;
    // The reachable end, on the same axis as the request.
    out[3] = rx + dx * dist;
    out[4] = ry + dy * dist;
    out[5] = rz + dz * dist;
}

/** Framerate-independent exponential approach. */
function damp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

function clamp(v, lo, hi) {
    return v < lo ? lo : v > hi ? hi : v;
}

/** Smoothstep on an already-normalised value, clamped at both ends. */
function smoothstep01(x) {
    const t = clamp(x, 0, 1);
    return t * t * (3 - 2 * t);
}

export class Figure {
    /**
     * @param {{heightAt(x:number,z:number):number, normalAt(x:number,z:number,out:any):any}} terrain
     */
    constructor(terrain) {
        this.terrain = terrain;

        /** World matrix per bone. */
        this.world = new Float32Array(BONE_COUNT * 16);
        /** Bind-pose world matrix per bone. */
        this.bind = new Float32Array(BONE_COUNT * 16);
        /** Inverse of the above. */
        this.invBind = new Float32Array(BONE_COUNT * 16);
        /** `world * invBind` — the matrix geometry is actually skinned by. */
        this.skin = new Float32Array(BONE_COUNT * 16);

        /** World joint positions, three floats per bone. Cloth collision reads these. */
        this.joint = new Float32Array(BONE_COUNT * 3);

        for (let b = 0; b < BONE_COUNT; b++) {
            const o = b * 9;
            setFrameFromDir(
                this.bind, b * 16,
                BIND[o], BIND[o + 1], BIND[o + 2],
                BIND[o + 3], BIND[o + 4], BIND[o + 5],
                BIND[o + 6], BIND[o + 7], BIND[o + 8]
            );
            invertRigid(this.invBind, b * 16, this.bind, b * 16);
        }

        // ------------------------------------------------------------- gait
        /** Where each foot is planted, world. Frozen for the whole stance phase. */
        this.plant = new Float32Array(6);
        /** Live foot position (equals `plant` during stance). */
        this.footPos = new Float32Array(6);
        /** Ground normal under each planted foot. */
        this.footNormal = new Float32Array([0, 1, 0, 0, 1, 0]);
        /** 1 while the foot carries weight, 0 mid-swing. Eased. */
        this.footWeight = new Float32Array([1, 1]);
        /**
         * Ankle pitch, radians, positive toe-down. Written by the gait machine
         * because that is the only place the stance and swing progress exist, and
         * read by the leg solver.
         */
        this.footPitch = new Float32Array(2);
        this._wasStance = [true, true];
        /** Set for one frame when a foot touches down. Drives spray and splats. */
        this.touchdown = [false, false];

        // ------------------------------------------------- smoothed pose state
        this.hipY = HIP_HEIGHT;
        this.pitch = 0;
        this.roll = 0;
        this.bob = 0;
        /**
         * Lateral pelvis shift, metres along the body's right axis.
         *
         * A walking person puts their centre of mass over the foot they are
         * standing on, once per step. It is three centimetres and it is most of
         * what separates walking from being slid along the ground: without it the
         * hips travel in a perfectly straight line no matter where the feet are.
         */
        this.sway = 0;
        /**
         * Pelvic list, radians. The hip on the swing side drops — the pelvis is
         * only supported on one leg at a time and it shows.
         */
        this.list = 0;
        this.headYaw = 0;
        this.headPitch = 0;
        this.hoodYaw = 0;
        this.hoodPitch = 0;
        this.armPhase = 0;
        /** How far the figure has settled into the snow, metres. */
        this.sink = 0.04;
        /** Landing compression, metres of extra crouch. Decays as a spring. */
        this.landSquash = 0;
        /**
         * The swing phase, delayed three times.
         *
         * A body does not rotate in one piece. Hips go first, the chest follows,
         * the shoulders whip through after that, the arm arrives last and the blade
         * later still — that lag chain *is* the kinetic chain, and running every
         * joint off the same instantaneous number is precisely what makes a
         * procedural swing look like a diagram.
         *
         * Springs rather than filters, and underdamped on purpose: each link
         * overshoots the one driving it, which is what a whip crack is. A damped
         * lag can only ever arrive late; it cannot arrive late and then go too far.
         */
        this.swingChest = 0;
        this.swingShoulder = 0;
        this.swingHand = 0;
        /**
         * The same three, after `swingSnap` has collapsed however much of the
         * separation the current attack does not want. These are what the pose
         * reads; the raw ones above are only the springs' state.
         */
        this.phaseChest = 0;
        this.phaseShoulder = 0;
        this.phaseHand = 0;
        this._chestVel = 0;
        this._shoulderVel = 0;
        this._handVel = 0;

        /**
         * A full 3D spring on each hand's target, as an offset from its shoulder.
         *
         * The scalar chain above delays the *phase*, but every link still travels
         * the same path — and a path followed with perfect fidelity at any delay
         * still reads as mechanical. This spring gives the hand real inertia in
         * space: the path itself bows wide under acceleration, overshoots the
         * reversal at the coil, and rounds the corner at the follow-through. It is
         * the difference between a point moving along a rail and a mass being
         * swung.
         *
         * Stored shoulder-relative so locomotion does not excite it: walking moves
         * the shoulder and the hand together, and only the *swing* puts energy in.
         */
        this._armPos = new Float32Array(6);
        this._armVel = new Float32Array(6);
        this._armLive = [false, false];
        /** Where the off hand takes hold during a two-handed stroke. */
        this._grip = new Float32Array(3);
        this._gripValid = false;

        this._t = 0;
        this._prevGait = 0;
        /** 0..1: how much of a walk cycle the legs are currently part of. */
        this._stride = 0;
    }

    /**
     * Pose the skeleton for this frame.
     * @param {number} dt
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, ch) {
        const h = Math.min(dt, 1 / 30);
        this._t += h;

        const surf = ch.surf;
        const speed = ch.speed;
        const run = Math.min(1, speed / 5.4);
        const air = ch.air;

        // A chained attack rebases the phase into its own plane; the springs shift
        // with it or they would see the rebase as a two-unit step to chase.
        if (ch.swingRebase !== 0) {
            this.swingChest += ch.swingRebase;
            this.swingShoulder += ch.swingRebase;
            this.swingHand += ch.swingRebase;
            ch.swingRebase = 0;
        }

        // The lag chain. `ch.swingArc` is the hips; each link after that is a
        // spring chasing the one before it, so it arrives late *and overshoots* —
        // hips, chest, shoulders, hand, and the blade's own spring after that.
        // Four substeps: the chain is stiff enough now that anything coarser is
        // inside the stability limit of a semi-implicit integrator.
        //
        // Hit-stop drops the springs into slow motion along with the phase clock —
        // the same rate, so the whole chain stays coherent. Not a freeze: the upper
        // body keeps travelling through contact, just at a third of the speed.
        const hs = h * 0.25 * (ch.hitstop > 0 ? HITSTOP_RATE : 1);
        for (let i = 0; i < 4; i++) {
            this._chestVel += (CHEST_K * (ch.swingArc - this.swingChest) - CHEST_C * this._chestVel) * hs;
            this.swingChest += this._chestVel * hs;
            this._shoulderVel += (SHOULDER_K * (this.swingChest - this.swingShoulder) - SHOULDER_C * this._shoulderVel) * hs;
            this.swingShoulder += this._shoulderVel * hs;
            this._handVel += (HAND_K * (this.swingShoulder - this.swingHand) - HAND_C * this._handVel) * hs;
            this.swingHand += this._handVel * hs;
        }

        // And then partly *undone*, by however much this attack asked for. A heavy
        // swing wants every link separated; a quick one turns nearly as one piece,
        // and the same lag that makes the finisher read as a whip makes the jab read
        // as loose. Collapsing the chain toward the driving phase is a cheaper and
        // far more controllable way to say that than a second set of springs.
        const snap = ch.swingSnap;
        this.phaseChest = this.swingChest + (ch.swingArc - this.swingChest) * snap;
        this.phaseShoulder = this.swingShoulder + (ch.swingArc - this.swingShoulder) * snap;
        this.phaseHand = this.swingHand + (ch.swingArc - this.swingHand) * snap;

        // ---------------------------------------------------------- footfalls
        // Stance/swing is derived from the same distance-driven phase the
        // controller uses to fire footfall events, so the visual plant and the
        // snow splat are the same instant by construction.
        this._updateFeet(h, ch);

        // -------------------------------------------------------- body attitude
        // Lean forward with speed, and *into* acceleration — the classic read
        // that a figure is pushing rather than being dragged.
        const fwdAcc =
            ch.acceleration.x * Math.sin(ch.facing) + ch.acceleration.z * Math.cos(ch.facing);
        // Clamped, because the accelerations at either end of a surf run are an
        // order of magnitude larger than anything walking produces: letting go at
        // top speed decelerates at 30 m/s^2, which unclamped throws the torso
        // twenty degrees backwards and reads as a fall rather than as a scrub.
        const pitchWant =
            0.10 * run
            + 0.012 * clamp(fwdAcc, -9, 22)
            + surf * (0.30 + 0.16 * ch.speed01)
            // In the air: a little back on the way up, forward over the descent.
            + air * clamp(-ch.velocityY * 0.022, -0.10, 0.16)
            // Behind the lunge, the whole body goes with the point.
            // The body goes with the strike, in proportion to how committed the
            // attack is: the jab leans a little, the finisher goes over the front
            // foot behind the blade.
            + 0.26 * ch.swingSet * clamp(ch.swingArc, 0, 1)
            // Flinch: hunch forward over the blow. Squared so the onset is sharp and
            // the tail is gentle — the trunk damp below rounds the front edge into
            // something a spine would do.
            + 0.30 * ch.flinch * ch.flinch;
        this.pitch = damp(this.pitch, pitchWant, 7, h);

        const rollWant = ch.lean * (0.16 + 0.34 * surf);
        this.roll = damp(this.roll, rollWant, 8, h);

        // Weight into the swing: the body leans away from the wind-up and over the
        // finish, and drops on its knees through the strike. Both are small numbers
        // and both are load-bearing — a swing with a level, upright body under it
        // is the pose of someone conducting, not fighting.
        //
        // Kept out of `this.roll`, which is smoothed state: adding to it would
        // accumulate a permanent list over a few swings.
        const swingLean = -this.phaseChest * 0.17 * ch.swingBlend * swingTurn(ch.swingPlane);

        // ----------------------------------------------------- gait mechanics
        //
        // Three oscillations, all keyed to the same distance-driven phase, and
        // between them they are the difference between walking and being slid
        // along the ground:
        //
        //   bob    vertical, twice per cycle. Lowest just after each footfall,
        //          where the leg is absorbing the landing, and highest over the
        //          supporting leg at mid-stance. This was inverted before — high
        //          at the plant, low at mid-stance — which is exactly the shape
        //          that makes a walk read as a hover.
        //   sway   lateral, once per cycle, toward the foot being stood on.
        //   list   the pelvis tipping as the unsupported hip drops.
        //
        // All three are gated on actually striding, and fade out at a crawl so a
        // character shuffling into position does not wobble.
        const gp = ch.gaitPhase;
        const striding = ch.stepping ? clamp(speed / 0.9, 0, 1) * (1 - surf) * (1 - air) : 0;
        // Published on the instance because the leg solver runs later in this same
        // update and needs to know whether the foot is part of a step at all.
        this._stride = striding;

        // 4 cm peak-to-peak at a walk, 10 cm at a full run. Measured off people:
        // the pelvis of someone running rises and falls about a hand's width.
        const bobAmp = (0.042 + 0.060 * run) * striding;
        // The dip lags the footfall slightly — the knee has to load before it
        // gives, and that lag is what reads as weight rather than as a bounce.
        const bobWant = -0.5 * bobAmp * Math.cos(4 * Math.PI * (gp - 0.06));
        this.bob = damp(this.bob, bobWant, 30, h);

        // Wider at a walk than a run: sprinting feet land much closer to the
        // midline, so there is less to shift across.
        const swayAmp = (0.030 - 0.014 * run) * striding;
        this.sway = damp(this.sway, -swayAmp * Math.sin(2 * Math.PI * gp), 20, h);

        const listAmp = (0.045 + 0.020 * run) * striding;
        this.list = damp(this.list, listAmp * Math.sin(2 * Math.PI * gp), 16, h);

        // Landing compression. Set on the touchdown frame and released as a
        // spring, so the knees absorb the drop instead of the whole figure
        // arriving rigid. This is the only part of the jump the player reads as
        // weight, and it is worth more than the arc itself.
        if (ch.landed) {
            this.landSquash = Math.max(this.landSquash, 0.045 + 0.10 * ch.landImpact);
        } else {
            this.landSquash = damp(this.landSquash, 0, 6.5, h);
        }

        // Crouch: a little at running speed, a lot on the board. Negative while
        // airborne — the legs come up under the body, so the hips ride higher.
        //
        // The run term is worth more than it looks: dropping the hips 9 cm at
        // speed is 9 cm of extra horizontal reach for the same leg, which is the
        // difference between a stride the IK can solve and one it has to clamp.
        const crouch =
            0.09 * run + surf * (0.13 + 0.05 * ch.speed01) + this.landSquash - 0.030 * air
            // Set into the stance: knees bent for the whole attack and released
            // late, so it finishes low and grounded rather than standing up out of
            // the follow-through. A little deeper still through the strike itself.
            + 0.075 * ch.swingSet
            + 0.035 * ch.swingBlend * Math.sin(Math.PI * clamp((ch.swingArc + 1) * 0.5, 0, 1))
            // The flinch dips the hips with the hunch: a blow lands in the knees as
            // much as the spine, and a hunch without the dip pivots the figure like a
            // hinged doll.
            + 0.10 * ch.flinch * ch.flinch;
        this.hipY = damp(this.hipY, HIP_HEIGHT - crouch, 9, h);

        // The figure settles into the snow it is standing on. Reading the real
        // depth would mean a GPU readback; this is the same number the contact
        // brushes are writing, held on the CPU. Nothing to sink into in flight.
        this.sink = damp(this.sink, (0.045 + surf * 0.055) * (1 - air), 4, h);

        // ------------------------------------------------------------- spine
        //
        // The pelvis is swayed off the character's ground position; the feet are
        // not. That is the mechanism, not a cheat: the body moves across its feet,
        // the feet stay where they were planted, and everything above the hips
        // inherits the shift.
        //
        // A swing adds a second shift, along the facing: the hips sit back over the
        // rear foot through the coil and drive forward over the front one as the
        // blade comes through. Nine centimetres, and it is the difference between a
        // strike thrown by the body and one thrown by the arm.
        const swayRx = Math.cos(ch.facing);
        const swayRz = -Math.sin(ch.facing);
        const push = ch.swingShift * 0.095 * ch.swingSet;
        const gx = ch.position.x + swayRx * this.sway + Math.sin(ch.facing) * push;
        const gz = ch.position.z + swayRz * this.sway + Math.cos(ch.facing) * push;
        // The surface the body is carried by — the snow underfoot, plus the jump
        // arc when there is one.
        const baseY = this.terrain.heightAt(gx, gz) + ch.airHeight;

        const rootY = baseY - this.sink + this.hipY + this.bob;

        const pelvisRoll = this.roll + swingLean + this.list;
        composeBasis(ch.facing, this.pitch, pelvisRoll);
        const rX = _axes[0], rY = _axes[1], rZ = _axes[2];
        const uX = _axes[3], uY = _axes[4], uZ = _axes[5];
        const fX = _axes[6], fY = _axes[7], fZ = _axes[8];

        // Pelvis. Its yaw counter-rotates against the shoulders during a stride,
        // which is most of what stops a procedural walk reading as a shop dummy.
        //
        // A swing turns the whole trunk, and it has to: a sword swung from the
        // shoulder alone is a man flapping. Ninety degrees of chest rotation with
        // the pelvis following at 55% means the shoulder itself travels through
        // the arc — the shoulders are built off the chest frame, so the arm gets
        // that rotation for free on top of its own sweep, and *that* is what makes
        // the blade cover as much ground as a bat.
        const turn = swingTurn(ch.swingPlane);
        const swingTwist = this.phaseChest * 0.95 * ch.swingBlend * turn;
        const twist =
            (1 - surf) * 0.13 * run * Math.sin(2 * Math.PI * ch.gaitPhase)
            // The pelvis gets the *undelayed* phase, which is what puts it ahead of
            // the chest in the chain rather than merely rotating less than it.
            + ch.swingArc * 0.95 * ch.swingBlend * turn * 0.55;
        composeBasis(ch.facing + twist, this.pitch, pelvisRoll);
        this._setBone(B_ROOT, gx, rootY, gz, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        const chestTwist = -twist * 1.5 + swingTwist;
        // The chest crunches through a strike: extended a little at the coil,
        // flexed forward past the finish. Off the *chest's* phase, so it arrives
        // with the rotation it belongs to rather than with the hips'.
        const crunch = 0.085 * clamp(this.phaseChest, -1, 1.3) * ch.swingBlend;
        const chestPitch = this.pitch + 0.05 * run + surf * 0.10 + crunch;

        // The spine takes the midpoint of the pelvis and the chest, in yaw and in
        // crunch. With the pelvis on the raw phase and the chest on its sprung
        // copy, the twist now travels visibly up the trunk — pelvis, waist,
        // ribcage, in that order — instead of the torso being two rigid pieces
        // that disagree at one joint.
        composeBasis(
            ch.facing + twist + (chestTwist - twist) * 0.5,
            this.pitch + crunch * 0.5,
            pelvisRoll
        );
        const spineY = rootY + uY * 0.11;
        this._setBone(
            B_SPINE, gx + uX * 0.11, spineY, gz + uZ * 0.11,
            _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]
        );

        // The trunk counter-lists against the pelvis. A shoulder line that tips
        // with the hips reads as a figure falling over sideways once a step; real
        // trunks stay much closer to level than the pelvis under them.
        composeBasis(ch.facing + chestTwist, chestPitch, (this.roll + swingLean) * 1.15 - this.list * 0.55);
        const cUx = _axes[3], cUy = _axes[4], cUz = _axes[5];
        const cFx = _axes[6], cFy = _axes[7], cFz = _axes[8];
        const cRx = _axes[0], cRy = _axes[1], cRz = _axes[2];

        const chestX = gx + uX * 0.31, chestY = rootY + uY * 0.31, chestZ = gz + uZ * 0.31;
        this._setBone(B_CHEST, chestX, chestY, chestZ, cUx, cUy, cUz, cFx, cFy, cFz);

        const neckX = chestX + cUx * 0.20, neckY = chestY + cUy * 0.20, neckZ = chestZ + cUz * 0.20;
        this._setBone(B_NECK, neckX, neckY, neckZ, cUx, cUy, cUz, cFx, cFy, cFz);

        // ------------------------------------------------------------- head
        // Head stabilisation: the head stays much closer to level than the chest
        // it sits on. Real necks do this and it is very obvious when missing.
        this.headPitch = damp(this.headPitch, -chestPitch * 0.62 + surf * 0.10, 9, h);
        // Look where the cut is going. The head leads the chest through a swing —
        // people watch the thing they are hitting — and a head that stays locked
        // forward through an attack is the last thing that reads as mechanical
        // after everything else has been fixed.
        const headSwing = ch.swingArc * 0.30 * ch.swingBlend * swingTurn(ch.swingPlane);
        // Faster while swinging: at the idle rate the head would still be turning
        // when the strike was over, which is worse than not turning at all.
        this.headYaw = damp(this.headYaw, ch.lean * -0.22 + headSwing, 6 + 16 * ch.swingBlend, h);
        composeBasis(ch.facing + chestTwist + this.headYaw, chestPitch + this.headPitch, this.roll * 0.5);
        const headX = neckX + cUx * 0.09, headY = neckY + cUy * 0.09, headZ = neckZ + cUz * 0.09;
        this._setBone(B_HEAD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // The hood is a lagged copy. A hood that tracks the skull exactly reads
        // as a helmet; a few frames of lag reads as fabric.
        this.hoodYaw = damp(this.hoodYaw, ch.facing + chestTwist + this.headYaw, 11, h);
        this.hoodPitch = damp(this.hoodPitch, chestPitch + this.headPitch + 0.05, 9, h);
        composeBasis(this.hoodYaw, this.hoodPitch, this.roll * 0.5);
        this._setBone(B_HOOD, headX, headY, headZ, _axes[3], _axes[4], _axes[5], _axes[6], _axes[7], _axes[8]);

        // -------------------------------------------------------------- arms
        this._poseArms(h, ch, chestX, chestY, chestZ, cRx, cRy, cRz, cUx, cUy, cUz, cFx, cFy, cFz);

        // -------------------------------------------------------------- legs
        this._poseLeg(0, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);
        this._poseLeg(1, gx, rootY, gz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ);

        // -------------------------------------------------------- somersault
        // Applied to the finished pose rather than folded into it. A tucked
        // front flip *is* a rigid rotation of the whole body about its centre of
        // mass, and doing it here means the legs, arms, head, hood and every
        // cloth attachment point come along without any of them knowing.
        if (ch.flipAngle > 1e-4) {
            this._rotateBody(
                ch.flipAngle,
                gx, rootY + FLIP_PIVOT_Y, gz,
                rX, rY, rZ
            );
        }

        // ------------------------------------------------------------- skin
        for (let b = 0; b < BONE_COUNT; b++) {
            mul(this.skin, b * 16, this.world, b * 16, this.invBind, b * 16);
            this.joint[b * 3] = this.world[b * 16 + 12];
            this.joint[b * 3 + 1] = this.world[b * 16 + 13];
            this.joint[b * 3 + 2] = this.world[b * 16 + 14];
        }
    }

    _setBone(b, px, py, pz, yx, yy, yz, zx, zy, zz) {
        // X = Y x Z, completing the frame from the bone axis and its front
        // reference. Both are already orthonormal at every call site.
        setFrameFromDir(this.world, b * 16, px, py, pz, yx, yy, yz, zx, zy, zz);
    }

    /**
     * Rotate every posed bone about a world axis through a pivot.
     *
     * Rigid, so it is Rodrigues on the three basis columns and on each bone's
     * offset from the pivot — no matrix multiply and no allocation. Run after
     * the pose is complete and before the skinning matrices are derived from it,
     * which is what lets a whole-body rotation be a hundred lines of nothing
     * instead of a second pose path.
     *
     * @param {number} angle radians, positive rotates forward (a front flip)
     * @param {number} px @param {number} py @param {number} pz pivot, world
     * @param {number} ax @param {number} ay @param {number} az unit axis
     */
    _rotateBody(angle, px, py, pz, ax, ay, az) {
        const c = Math.cos(angle);
        const s = Math.sin(angle);
        const t = 1 - c;
        const w = this.world;

        for (let b = 0; b < BONE_COUNT; b++) {
            const o = b * 16;
            for (let col = 0; col < 3; col++) {
                const i = o + col * 4;
                rodrigues(w[i], w[i + 1], w[i + 2], ax, ay, az, c, s, t);
                w[i] = _rv[0]; w[i + 1] = _rv[1]; w[i + 2] = _rv[2];
            }
            rodrigues(
                w[o + 12] - px, w[o + 13] - py, w[o + 14] - pz,
                ax, ay, az, c, s, t
            );
            w[o + 12] = px + _rv[0];
            w[o + 13] = py + _rv[1];
            w[o + 14] = pz + _rv[2];
        }
    }

    /**
     * Advance the stance/swing state machine and place both ankles.
     *
     * Stance is the whole point. `plant` is written exactly once, on touchdown,
     * and read unchanged for the rest of the stance — so no amount of body
     * motion, camera motion or frame-rate variation can move a planted foot.
     */
    _updateFeet(h, ch) {
        const surf = ch.surf;
        const speed = ch.speed;
        const run = Math.min(1, speed / 5.4);
        // Duty factor: a walk keeps both feet down for a moment, a run has a
        // flight phase. Interpolating between them is what makes the transition
        // from walk to run read as a gait change and not a speed change.
        const duty = 0.66 - 0.20 * run;

        const fwdX = Math.sin(ch.facing), fwdZ = Math.cos(ch.facing);
        const rgtX = Math.cos(ch.facing), rgtZ = -Math.sin(ch.facing);

        // Half a step ahead of the body at touchdown. A full cycle is two steps,
        // so a symmetric stride puts the plant a quarter of a cycle's travel in
        // front — read straight off the controller's stride so the two cannot
        // drift apart.
        //
        // Capped, and the cap is a statement about leg length rather than about
        // taste: the hip sits about 0.72 m above the ankle at speed and the leg is
        // 0.81 m, so anything past ~0.4 m of reach is already asking the knee to
        // straighten. 0.58 keeps a sprint looking like a sprint, and the IK's own
        // reach clamp absorbs the rest by letting the foot lag its plant a little
        // at the extremes — which is invisible, where a stretched shin is not.
        const half = Math.min(ch.strideLength * 0.25, 0.58);
        // The controller owns this decision — see `stepping` there. Re-deriving
        // it from `surf` here is how the feet and the footprints end up
        // disagreeing about whether the character is walking.
        const moving = speed > 0.2 && ch.stepping;

        for (let f = 0; f < 2; f++) {
            const side = f === 0 ? -0.105 : 0.105;
            // Left foot leads; the right is half a cycle behind.
            const ph = (ch.gaitPhase + (f === 0 ? 0 : 0.5)) % 1;
            const stance = !moving || ph < duty;

            // Where this foot would land if it touched down right now.
            const nx = ch.position.x + fwdX * half + rgtX * side;
            const nz = ch.position.z + fwdZ * half + rgtZ * side;

            if (stance) {
                if (!this._wasStance[f]) {
                    // Touchdown. This is the only line in the file that writes a
                    // plant position.
                    this.plant[f * 3] = nx;
                    this.plant[f * 3 + 1] = this.terrain.heightAt(nx, nz) - this.sink * 0.7;
                    this.plant[f * 3 + 2] = nz;
                    this.touchdown[f] = true;
                } else {
                    this.touchdown[f] = false;
                }
                if (!moving) {
                    // Standing: ease the feet back under the hips rather than
                    // leaving them wherever the last stride dropped them.
                    const sx = ch.position.x + rgtX * side + fwdX * 0.02;
                    const sz = ch.position.z + rgtZ * side + fwdZ * 0.02;
                    this.plant[f * 3] = damp(this.plant[f * 3], sx, 7, h);
                    this.plant[f * 3 + 2] = damp(this.plant[f * 3 + 2], sz, 7, h);
                    this.plant[f * 3 + 1] = damp(
                        this.plant[f * 3 + 1],
                        this.terrain.heightAt(this.plant[f * 3], this.plant[f * 3 + 2]) - this.sink * 0.7,
                        7, h
                    );
                }
                this.footPos[f * 3] = this.plant[f * 3];
                this.footPos[f * 3 + 1] = this.plant[f * 3 + 1];
                this.footPos[f * 3 + 2] = this.plant[f * 3 + 2];
                this.footWeight[f] = damp(this.footWeight[f], 1, 22, h);

                // Ankle through stance: arrives heel-first, rolls flat through the
                // middle, drives the heel up at the end. This is the roll a foot
                // does, and without it the sole stays parallel to the ground for
                // the whole step — which is most of why a procedural walk reads as
                // a mannequin being slid forward.
                const st = moving ? clamp(ph / duty, 0, 1) : 0;
                const heel = -HEEL_STRIKE * (1 - smoothstep01(st / 0.22));
                const toeOff = TOE_OFF * smoothstep01((st - 0.68) / 0.32) * (0.55 + 0.45 * run);
                this.footPitch[f] = damp(this.footPitch[f], heel + toeOff, 20, h);
            } else {
                this.touchdown[f] = false;
                // Swing: from the plant it is leaving to the plant it is heading
                // for, on an arc. `nx/nz` keeps updating as the body moves, so
                // the foot is always aimed at where the body will actually be.
                const s = (ph - duty) / (1 - duty);
                const e = s * s * (3 - 2 * s);
                const ny = this.terrain.heightAt(nx, nz) - this.sink * 0.7;
                const px = this.plant[f * 3], py = this.plant[f * 3 + 1], pz = this.plant[f * 3 + 2];
                this.footPos[f * 3] = px + (nx - px) * e;
                this.footPos[f * 3 + 2] = pz + (nz - pz) * e;
                this.footPos[f * 3 + 1] =
                    py + (ny - py) * e + Math.sin(Math.PI * s) * (0.055 + 0.18 * run);
                this.footWeight[f] = damp(this.footWeight[f], 0, 22, h);

                // Through swing: the toe stays down out of toe-off, then the ankle
                // dorsiflexes to clear the ground and to present the heel for the
                // next contact.
                const trail = TOE_OFF * Math.pow(1 - s, 1.5);
                const reach = -HEEL_STRIKE * smoothstep01((s - 0.5) / 0.5);
                this.footPitch[f] = damp(this.footPitch[f], trail + reach, 16, h);
            }

            this._wasStance[f] = stance;
        }

        // Surfing: both feet ride the board, offset along the body's long axis
        // and rotated across the direction of travel. Blended in, never snapped.
        if (surf > 0.001) {
            for (let f = 0; f < 2; f++) {
                // Wide and staggered: feet apart across the direction of travel
                // for lateral stability, with the leading foot a little ahead.
                const lateral = f === 0 ? -0.17 : 0.17;
                const along = f === 0 ? 0.11 : -0.11;
                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                const sy = this.terrain.heightAt(sx, sz) - this.sink;
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * surf;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * surf;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * surf;
                this.footWeight[f] = Math.max(this.footWeight[f], surf);
            }
        }

        // Airborne: the feet leave the surface entirely, so they are posed off
        // the body rather than off the ground.
        //
        // The tuck is driven by the sign of the vertical velocity, not by the
        // time in the air. Knees come up on the climb, and the legs reach back
        // down over the descent so the figure is already extended when it
        // arrives — which is what makes the landing read as anticipated instead
        // of as a collision.
        const air = ch.air;
        if (air > 0.001) {
            const rise = clamp(ch.velocityY / 5.0, -1, 1);
            // The somersault tucks regardless of which way it is travelling.
            const tuck = Math.max(Math.max(0, rise), ch.flip01);
            for (let f = 0; f < 2; f++) {
                const lateral = f === 0 ? -0.11 : 0.11;
                // Slight stagger, strongest at the top of the climb — and gone
                // in a tuck, where the knees come up together.
                const along =
                    (f === 0 ? 0.12 : -0.09) * (0.35 + 0.65 * tuck) * (1 - 0.7 * ch.flip01);
                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                // Measured down from the body, which is already carrying the
                // jump height. Kept clear of full leg extension (0.81 m hip to
                // sole) — target the ankle past that and the IK locks the knee
                // and the shin skins as a stretched pole.
                const sy = ch.position.y + 0.10 + 0.24 * tuck;
                const o = f * 3;
                this.footPos[o] += (sx - this.footPos[o]) * air;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * air;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * air;
                // Unloaded, so the ankles point their toes.
                this.footWeight[f] = Math.min(this.footWeight[f], 1 - air);
            }
        }

        // Nothing plants in mid-air. The stance machine above runs on the gait
        // phase, which is frozen while airborne, but the frame the freeze starts
        // on can still look like a touchdown to it.
        if (ch.airborne) {
            this.touchdown[0] = false;
            this.touchdown[1] = false;
        }

        // ------------------------------------------------------ fighting stance
        //
        // A swing is thrown from the ground. The feet go wide and staggered — front
        // foot toward the target, back foot behind and out — and the weight travels
        // between them: onto the back leg through the coil, driven onto the front
        // foot as the blade comes through. The front foot also *steps* forward as it
        // takes the weight, which is what makes the strike land rather than merely
        // happen.
        //
        // Faded out with speed, because a character already walking has a gait that
        // owns its feet and blending a static stance over it fights that.
        const set = ch.swingSet * (1 - Math.min(1, speed / 2.4));
        if (set > 0.001 && !ch.airborne) {
            const shift = ch.swingShift;
            for (let f = 0; f < 2; f++) {
                const front = f === 0;
                // Front foot forward and inboard, back foot behind and wide.
                const along = front ? 0.24 + 0.14 * Math.max(0, shift) : -0.30;
                const lateral = front ? -0.14 : 0.20;
                const sx = ch.position.x + fwdX * along + rgtX * lateral;
                const sz = ch.position.z + fwdZ * along + rgtZ * lateral;
                // The loaded leg sinks; the unloaded one only rests on the surface.
                const load = front ? Math.max(0, shift) : Math.max(0, -shift);
                const sy = this.terrain.heightAt(sx, sz) - this.sink * (0.5 + 0.7 * load);
                const o = f * 3;
                this.plant[o] += (sx - this.plant[o]) * set;
                this.plant[o + 1] += (sy - this.plant[o + 1]) * set;
                this.plant[o + 2] += (sz - this.plant[o + 2]) * set;
                this.footPos[o] += (sx - this.footPos[o]) * set;
                this.footPos[o + 1] += (sy - this.footPos[o + 1]) * set;
                this.footPos[o + 2] += (sz - this.footPos[o + 2]) * set;
                this.footWeight[f] = Math.max(this.footWeight[f], set * (0.4 + 0.6 * load));
                // Flat feet: a fighting stance is not mid-step.
                this.footPitch[f] = damp(this.footPitch[f], 0, 18, h);
            }
        }
    }

    /**
     * Solve one leg. `f` is 0 for left, 1 for right.
     *
     * The knee pole tilts outward as well as forward, because a knee that bends
     * in a perfectly sagittal plane looks mechanical — real legs track slightly
     * wide of the hip.
     */
    _poseLeg(f, rootX, rootY, rootZ, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const side = f === 0 ? -0.10 : 0.10;
        const hipB = f === 0 ? B_THIGH_L : B_THIGH_R;
        const shinB = f === 0 ? B_SHIN_L : B_SHIN_R;
        const footB = f === 0 ? B_FOOT_L : B_FOOT_R;

        // Hip joint, carried by the pelvis frame.
        _hip[0] = rootX + rX * side - uX * 0.05;
        _hip[1] = rootY + rY * side - uY * 0.05;
        _hip[2] = rootZ + rZ * side - uZ * 0.05;

        const ax = this.footPos[f * 3];
        const ay = this.footPos[f * 3 + 1] + 0.09; // ankle sits above the sole
        const az = this.footPos[f * 3 + 2];

        const outward = f === 0 ? -0.22 : 0.22;
        solveTwoBone(
            _hip[0], _hip[1], _hip[2], ax, ay, az,
            fX + rX * outward, fY + rY * outward, fZ + rZ * outward,
            THIGH_LEN, SHIN_LEN, _knee
        );

        // The ankle the solver could actually reach. At a sprint this is a few
        // centimetres short of where the gait asked for the foot, and taking it
        // from here is what keeps the shin the length of a shin.
        const ex = _knee[3], ey = _knee[4], ez = _knee[5];

        this._setBone(
            hipB, _hip[0], _hip[1], _hip[2],
            _knee[0] - _hip[0], _knee[1] - _hip[1], _knee[2] - _hip[2],
            fX, fY, fZ
        );
        this._setBone(
            shinB, _knee[0], _knee[1], _knee[2],
            ex - _knee[0], ey - _knee[1], ez - _knee[2],
            fX, fY, fZ
        );

        // The foot rolls through the step — heel-first, flat, then driving off the
        // toe — from the pitch the gait machine solved. While surfing or airborne
        // there is no step to be part of, so it falls back to pointing the toe
        // whenever the foot is unloaded.
        const w = this.footWeight[f];
        const stride = this._stride;
        const roll = this.footPitch[f] * stride + (1 - w) * 0.55 * (1 - stride);
        const c = Math.cos(roll), s = Math.sin(roll);
        // Rotate the foot's forward axis down about the body's right axis.
        const dx = fX * c - uX * s, dy = fY * c - uY * s, dz = fZ * c - uZ * s;
        this._setBone(footB, ex, ey, ez, dx, dy, dz, uX, uY, uZ);
    }

    /**
     * Arms. Counter-swing against the legs while walking, and a wide, low
     * bending stance while surfing — hands out and forward, which is the
     * Water Tribe pose in the reference and also just what a person does at
     * twenty metres a second.
     */
    _poseArms(h, ch, cx, cy, cz, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ) {
        const surf = ch.surf;
        const run = Math.min(1, ch.speed / 5.4);
        // Counter-swing amplitude. Halved from where this started: the cadence it
        // rides on used to be about twice a plausible one, and the two together
        // read as a figure sprinting on the spot. A real arm swing at a jog is
        // most of a hand's width fore and aft, not a metre.
        const swing = Math.sin(2 * Math.PI * ch.gaitPhase) * (0.13 + 0.24 * run) * (1 - surf);
        // Slow idle drift so a standing figure is never perfectly still.
        const idle = Math.sin(this._t * 0.9) * 0.02 + Math.sin(this._t * 1.7 + 1.3) * 0.012;

        // The sword arm is solved *first*, off arm second.
        //
        // Reversed from the obvious order because a two-handed grip needs the off hand to
        // reach the sword's handle, and the handle is wherever the sword hand ended up.
        // The alternative is using last frame's position, which at the speed a finisher
        // travels would leave a visible gap between the hands on exactly the stroke this
        // exists for.
        for (let ai = 0; ai < 2; ai++) {
            const a = 1 - ai;
            const sgn = a === 0 ? -1 : 1;
            const upperB = a === 0 ? B_UPPER_L : B_UPPER_R;
            const foreB = a === 0 ? B_FORE_L : B_FORE_R;
            const handB = a === 0 ? B_HAND_L : B_HAND_R;

            // Shoulder, on the chest frame — and then rotated a little further
            // back, by however far the shoulders are still lagging the chest.
            //
            // This is the third link of the chain and the one the brief calls the
            // shoulders whipping through last. Without it the shoulders are welded
            // to the ribcage and the sequence is hips, chest, arm, with nothing in
            // between; with it the arm is thrown from a shoulder that is itself
            // still accelerating.
            _sh[0] = cx + rX * (sgn * 0.185) + uX * 0.14;
            _sh[1] = cy + rY * (sgn * 0.185) + uY * 0.14;
            _sh[2] = cz + rZ * (sgn * 0.185) + uZ * 0.14;

            if (ch.swingBlend > 0.001 && ch.swingPlane > 0) {
                const lag =
                    (this.phaseShoulder - this.phaseChest) * 0.95 * ch.swingBlend *
                    swingTurn(ch.swingPlane);
                if (lag > 1e-4 || lag < -1e-4) {
                    rodrigues(
                        _sh[0] - cx, _sh[1] - cy, _sh[2] - cz,
                        uX, uY, uZ, Math.cos(lag), Math.sin(lag), 1 - Math.cos(lag)
                    );
                    _sh[0] = cx + _rv[0];
                    _sh[1] = cy + _rv[1];
                    _sh[2] = cz + _rv[2];
                }
            }

            // ---- walk target: hand swings fore and aft below the hip --------
            //
            // Every offset here is kept comfortably inside the arm's 0.54 m
            // reach. Put the target at or past full extension and the IK solver
            // does exactly what it is told — locks the elbow — and the figure
            // walks around with two straight poles for arms.
            //
            // The right arm is the sword arm, and while walking it is deliberately
            // much quieter: a third of the swing and held a little further out from
            // the hip. A hand carrying a metre of ice does not counter-swing like an
            // empty one, and the swing is multiplied by the blade's length by the
            // time it reaches the point — which is what was throwing the sword
            // through the thigh at a run.
            //
            // The left arm keeps the full locomotion swing. That is deliberate too:
            // it is now the *only* motion the off arm generates for itself, so a
            // walking figure still has a natural arm on one side, and everything
            // else that arm does is either casting or being carried by the trunk.
            const isSword = a === 1;
            const sw = swing * -sgn * (isSword ? 0.32 : 1.0);
            const clear = isSword ? 0.085 : 0;
            let tx = _sh[0] + fX * (sw * 0.38) - uX * 0.43 + rX * (sgn * 0.11 + clear);
            let ty = _sh[1] + fY * (sw * 0.38) - uY * 0.43 + rY * (sgn * 0.11 + clear);
            let tz = _sh[2] + fZ * (sw * 0.38) - uZ * 0.43 + rZ * (sgn * 0.11 + clear);
            ty += idle * sgn;

            // ---- cast target: the off hand bends, the sword hand stays -------
            //
            // **The left hand casts.** It is the hand with nothing in it, it is the
            // hand the spells are emitted from, and giving it the job is what lets
            // the two arms have one clear responsibility each: the right one fights
            // and the left one bends water. Before this the right hand led every
            // cast, which meant a hand holding a metre of ice was also the one
            // shaping the spell.
            //
            // The sword arm still participates, but only as a brace — a fifth of
            // the reach, tucked in and low. A body throwing a spell one-handed
            // leans and counterweights with the other side; it does not hold that
            // side rigidly at its walk pose.
            //
            // Blended, not switched, and it composes with the walk swing rather
            // than replacing it — a character casting while walking still walks.
            const cast = ch.cast;
            if (cast > 0.001) {
                const ax = ch.castAimX, ay = ch.castAimY, az = ch.castAimZ;
                const lead = a === 0;
                const outward = lead ? 0.30 : -0.16;
                const along = lead ? 0.52 : 0.14;
                const lift = lead ? 0.26 : -0.04;
                const cx = _sh[0] + rX * (sgn * 0.30 + outward * sgn) + ax * along + uX * lift;
                const cy = _sh[1] + rY * (sgn * 0.30) + ay * along + uY * lift + lift * 0.6;
                const cz = _sh[2] + rZ * (sgn * 0.30 + outward * sgn) + az * along + uZ * lift;
                // The bracing arm commits far less than the casting one.
                const w = cast * (lead ? 1 : 0.45);
                tx += (cx - tx) * w;
                ty += (cy - ty) * w;
                tz += (cz - tz) * w;
            }

            // ---- surf target: out, forward and a little down ----------------
            if (surf > 0.001) {
                const carve = ch.carve;
                // Trailing arm rises, leading arm drops into the turn — the
                // same asymmetry a snowboarder holds through a carve.
                const rise = 0.02 + carve * sgn * 0.22;
                const sx = _sh[0] + rX * (sgn * 0.33) + fX * 0.24 + uX * rise;
                const sy = _sh[1] + rY * (sgn * 0.33) + fY * 0.24 + uY * rise;
                const sz = _sh[2] + rZ * (sgn * 0.33) + fZ * 0.24 + uZ * rise;
                tx += (sx - tx) * surf;
                ty += (sy - ty) * surf;
                tz += (sz - tz) * surf;
            }

            // ---- somersault tuck: hands in to the chest ---------------------
            // A tuck is what makes a rotation read as deliberate. It is also the
            // reason the flip can turn as fast as it does — arms out and the
            // same rotation looks like a fall.
            const flip = ch.flip01;
            if (flip > 0.001) {
                const kx = _sh[0] + fX * 0.13 - uX * 0.13 + rX * (sgn * 0.07);
                const ky = _sh[1] + fY * 0.13 - uY * 0.13 + rY * (sgn * 0.07);
                const kz = _sh[2] + fZ * 0.13 - uZ * 0.13 + rZ * (sgn * 0.07);
                tx += (kx - tx) * flip;
                ty += (ky - ty) * flip;
                tz += (kz - tz) * flip;
            }

            // ---- swing target: the uncoil, sword arm only --------------------
            //
            // The sword hand sweeps its bowed arc about its own shoulder, and the
            // reach grows through the middle of it: a swing folds on the wind-up,
            // extends hard through contact and folds again on the follow-through,
            // and the extension at impact is what puts the tip where the body alone
            // could not.
            //
            // The off arm is not here at all. It keeps its locomotion swing and its
            // casting stance; during an attack it is carried by the trunk and
            // trailed by its own spring, which is what an arm that is not doing
            // anything does while the body it is attached to turns.
            const swingW = ch.swingBlend;
            if (a === 1 && swingW > 0.001 && ch.swingPlane > 0) {
                const s01 = (this.phaseHand + 1) * 0.5;
                swingDirection(
                    ch.swingPlane, s01, rX, rY, rZ, uX, uY, uZ, fX, fY, fZ,
                    ch.swingBridge, ch.swingFromPlane, ch.swingFromArc
                );

                const extend = SWING_REACH + SWING_EXTEND * Math.sin(Math.PI * clamp(s01, 0, 1));
                const gx2 = _sh[0] + _sd[0] * extend;
                const gy2 = _sh[1] + _sd[1] * extend;
                const gz2 = _sh[2] + _sd[2] * extend;

                tx += (gx2 - tx) * swingW;
                ty += (gy2 - ty) * swingW;
                tz += (gz2 - tz) * swingW;
            }

            // ---- both hands on the grip --------------------------------------
            //
            // The off hand goes to the handle, below the sword hand, for as long as
            // `swingGrip` says so. It is set from the *sword* arm's solved wrist, which is
            // why this loop runs in reverse.
            //
            // Blended rather than snapped, and blended toward a point on the handle rather
            // than at the sword hand itself: two hands occupying one point is what a
            // clasp looks like, and a hand's width apart is what a grip looks like.
            if (a === 0 && ch.swingGrip > 0.002 && this._gripValid) {
                const g = ch.swingGrip;
                tx += (this._grip[0] - tx) * g;
                ty += (this._grip[1] - ty) * g;
                tz += (this._grip[2] - tz) * g;
            }

            // ---- give the hand mass ------------------------------------------
            //
            // Everything above decided where the hand *should* be. This spring is
            // where it actually is: a 3D integration of the target, shoulder-
            // relative, underdamped. The path bows wide through the fast part of
            // the sweep, overshoots the reversal at the coil, and rounds the
            // follow-through — none of which any amount of phase lag along the
            // ideal path can produce, because they are deviations *from* the path.
            //
            // Seeded on activation and released with the blend, so it costs
            // nothing and changes nothing while the arms are just walking.
            if (ch.swingBlend > 0.01) {
                const o = a * 3;
                if (!this._armLive[a]) {
                    this._armLive[a] = true;
                    this._armPos[o] = tx - _sh[0];
                    this._armPos[o + 1] = ty - _sh[1];
                    this._armPos[o + 2] = tz - _sh[2];
                    this._armVel[o] = 0;
                    this._armVel[o + 1] = 0;
                    this._armVel[o + 2] = 0;
                }
                // Same slow motion the rest of the swing takes at contact. And the
                // same `snap` the phase chain obeys: the jab's spring is half again as
                // stiff as the finisher's, so the quick attack stays tight while
                // the heavy one swings wide.
                const ah = (h / 4) * (ch.hitstop > 0 ? HITSTOP_RATE : 1);
                const ak = ARM_K * (1 + ch.swingSnap);
                const ac = ARM_C * (1 + 0.5 * ch.swingSnap);
                const kx = tx - _sh[0];
                const ky = ty - _sh[1];
                const kz = tz - _sh[2];
                for (let n = 0; n < 4; n++) {
                    this._armVel[o] += (ak * (kx - this._armPos[o]) - ac * this._armVel[o]) * ah;
                    this._armVel[o + 1] += (ak * (ky - this._armPos[o + 1]) - ac * this._armVel[o + 1]) * ah;
                    this._armVel[o + 2] += (ak * (kz - this._armPos[o + 2]) - ac * this._armVel[o + 2]) * ah;
                    this._armPos[o] += this._armVel[o] * ah;
                    this._armPos[o + 1] += this._armVel[o + 1] * ah;
                    this._armPos[o + 2] += this._armVel[o + 2] * ah;
                }
                // Weighted by the blend, so the spring hands the arm back to the
                // walk pose as the attack fades instead of dropping it.
                tx += (_sh[0] + this._armPos[o] - tx) * ch.swingBlend;
                ty += (_sh[1] + this._armPos[o + 1] - ty) * ch.swingBlend;
                tz += (_sh[2] + this._armPos[o + 2] - tz) * ch.swingBlend;
            } else {
                this._armLive[a] = false;
            }

            // ---- elbow pole ---------------------------------------------------
            //
            // The elbow travels through a swing: up and behind the blade at the
            // coil — a raised elbow is most of what a wind-up silhouette is — then
            // dropping under and out as the arm extends through the strike. A
            // fixed pole holds the elbow at one attitude through 175 degrees of
            // sweep, and it is one of those things that is invisible until it is
            // fixed and obvious afterwards.
            let px = -fX + rX * (sgn * 0.55);
            let py = -fY + rY * (sgn * 0.55) - 0.35;
            let pz = -fZ + rZ * (sgn * 0.55);
            if (ch.swingBlend > 0.001 && ch.swingPlane > 0) {
                const e01 = clamp(((a === 1 ? this.phaseShoulder : this.phaseChest) + 1) * 0.5, 0, 1.2);
                // Coil: elbow high and pulled back. Strike: low, out, and forward.
                const cw = 1 - e01;
                let lat = sgn * (0.30 + 0.55 * e01);
                let vert = 0.85 * cw - 0.55 * e01;
                let fwd = -0.6 * cw + 0.35 * e01;

                // How high the hand is in the body's own frame, +1 straight up. `_sd` is
                // the swing direction this frame, already in world space, so the body's up
                // axis projects it back.
                const hu = a === 1
                    ? clamp(_sd[0] * uX + _sd[1] * uY + _sd[2] * uZ, -1, 1)
                    : 0;
                const high = clamp((hu - 0.25) / 0.6, 0, 1);

                // A raised arm's elbow points out to the side and a little down. It is
                // never above the hand, because the hand is already above the shoulder and
                // there is no room left — and more importantly, a vertical pole on a
                // vertical limb axis is parallel to it, which leaves the elbow direction
                // undefined and flipping between frames. The overhead finisher spent its
                // whole coil in that state.
                lat += high * 0.90;
                vert = vert * (1 - high) - high * 0.55;
                fwd += high * 0.25;

                // The off arm, while it is holding on. Its elbow tucks in toward the body
                // and drops, because an arm reaching across to a handle it is not leading
                // has nowhere else to put it — and because an off elbow winging outward is
                // the single clearest tell that two hands are on a sword by accident
                // rather than on purpose.
                if (a === 0 && ch.swingGrip > 0.002) {
                    const g = ch.swingGrip;
                    lat += (sgn * 0.55 - lat) * g;
                    vert += (-0.75 - vert) * g;
                    fwd += (0.20 - fwd) * g;
                }

                const ex = rX * lat + uX * vert + fX * fwd;
                const ey = rY * lat + uY * vert + fY * fwd;
                const ez = rZ * lat + uZ * vert + fZ * fwd;
                px += (ex - px) * ch.swingBlend;
                py += (ey - py) * ch.swingBlend;
                pz += (ez - pz) * ch.swingBlend;
            }
            solveTwoBone(
                _sh[0], _sh[1], _sh[2], tx, ty, tz, px, py, pz,
                UPPER_LEN, FORE_LEN, _p
            );
            // The wrist the solver could reach — same reasoning as the ankle.
            const wx = _p[3], wy = _p[4], wz = _p[5];

            this._setBone(
                upperB, _sh[0], _sh[1], _sh[2],
                _p[0] - _sh[0], _p[1] - _sh[1], _p[2] - _sh[2],
                fX, fY, fZ
            );
            this._setBone(
                foreB, _p[0], _p[1], _p[2],
                wx - _p[0], wy - _p[1], wz - _p[2],
                fX, fY, fZ
            );
            // Where the off hand should take hold, if this stroke is two-handed: a
            // hand's width down the handle from the sword hand, along the forearm's own
            // axis — which is the grip's axis, because the hand continues the forearm and
            // the sword continues the hand.
            if (a === 1) {
                const gx = wx - _p[0], gy = wy - _p[1], gz = wz - _p[2];
                const gl = Math.hypot(gx, gy, gz) || 1;
                this._grip[0] = wx - (gx / gl) * GRIP_DROP;
                this._grip[1] = wy - (gy / gl) * GRIP_DROP;
                this._grip[2] = wz - (gz / gl) * GRIP_DROP;
                this._gripValid = true;
            }

            // The hand continues the forearm, rolled palm-inward.
            let hx = wx - _p[0], hy = wy - _p[1], hz = wz - _p[2];
            const hl = Math.hypot(hx, hy, hz) || 1;
            hx /= hl; hy /= hl; hz /= hl;
            this._setBone(handB, wx, wy, wz, hx, hy, hz, fX, fY, fZ);
        }
    }

    /** World position of a hand, for spell emitters. Writes 3 floats to `out`. */
    handPosition(which, out, od) {
        const b = which === 0 ? B_HAND_L : B_HAND_R;
        xformPoint(this.world, b * 16, 0, 0.09, 0, out, od);
    }
}

export { HIP_HEIGHT };
