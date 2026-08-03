/**
 * Where the character meets the snow.
 *
 * Translates locomotion state into brushes on the terrain state buffer. This is
 * the only thing standing between the physics in `controller.js` and the marks
 * left on the field, and it is deliberately separate from both: the controller
 * should not know a deformation buffer exists, and the buffer should not know
 * what a foot is.
 *
 * Three writers:
 *
 *   footfall   one splat per plant, frame-accurate with the gait event. A boot
 *              is longer than it is wide and oriented with the body, so the
 *              brush is elongated and yawed rather than round.
 *   body drag  a shallow continuous scuff under a walking character, so the
 *              trail is a trail and not a row of disconnected prints.
 *   surf wake  a deep continuous groove with berms thrown to the outside of the
 *              turn. This is the centrepiece's mark on the world.
 *   landing    one wide crater and a radial burst when a jump touches down.
 *
 * Zero allocation: brushes are pushed straight into the field's staging array.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * Boot geometry, metres. `WIDTH` is the short-axis radius, so the print is
 * 20 cm across and 34 cm long — a boot plus the collapse of the snow around it,
 * which is what a print in deep snow actually measures. Narrower than this and
 * the print is only six texels wide and the rim detail has nowhere to live.
 */
const BOOT_WIDTH = 0.10;
const BOOT_ELONG = 1.7;

/** Surf groove geometry, metres. */
const SURF_WIDTH = 0.30;
const SURF_ELONG = 2.6;

/**
 * Sword cut geometry. Narrow, long and shallow: the short-axis radius is 7 cm and
 * the cut runs five times that across the swing.
 */
const SLASH_WIDTH = 0.07;
const SLASH_ELONG = 5.0;
/** How close the point has to come to the snow to cut it, metres. */
const SLASH_REACH = 0.34;

/** Scratch for the blade tip. */
const _tip = new Vector3();
/** Scratch for a point along the blade. */
const _blade = new Vector3();

function clamp01(v) {
    return v < 0 ? 0 : v > 1 ? 1 : v;
}

export class SnowContact {
    /**
     * @param {import("./controller.js").CharacterController} character
     * @param {import("../terrain/deformation.js").DeformationField} field
     * @param {import("./figure.js").Figure} [figure] posed skeleton, if built
     * @param {import("../vfx/particles.js").SprayField} [spray]
     * @param {import("./sword.js").IceSword} [sword] the blade, for slash marks
     */
    constructor(character, field, figure, spray, sword) {
        this.character = character;
        this.field = field;
        this.spray = spray || null;
        /**
         * The blade, when there is one. Read only on the frame a strike lands, and
         * read rather than told because only the sword knows where its own point
         * ended up after the hand that carries it was posed.
         */
        this.sword = sword || null;
        /**
         * The posed figure, when there is one.
         *
         * The controller also produces footfall events, and they are close
         * enough to be tempting. But "close enough" is exactly what a footprint
         * cannot be: the print has to be under the boot, and only the figure
         * knows where the boot actually planted, because it is the thing that
         * decided. Taking the event from the same state machine that freezes the
         * stance foot makes the two agree by construction rather than by
         * matching two sets of constants.
         */
        this.figure = figure || null;

        /** Distance travelled since the last continuous splat, metres. */
        this._sinceSplat = 0;
        this._prevX = character.position.x;
        this._prevZ = character.position.z;
        /** Last frame's blade tip, for the trail. */
        this._prevTip = new Vector3();
        this._tipInit = false;
    }

    /** @param {number} dt seconds */
    update(dt) {
        const ch = this.character;
        const f = this.field;

        const dx = ch.position.x - this._prevX;
        const dz = ch.position.z - this._prevZ;
        const moved = Math.hypot(dx, dz);
        this._prevX = ch.position.x;
        this._prevZ = ch.position.z;

        // Nothing is touching the snow in mid-air. Without this the groove keeps
        // being cut under a character who is two metres above it.
        if (!ch.airborne) {
            if (ch.surf > 0.02) this._surf(dt, moved);
            if (ch.surf < 0.98) this._walk(dt, moved);
        }

        if (ch.landed) this._land();
        if (ch.stompHit) this._stomp();
        if (ch.slashHit) this._slash();
        if (ch.swingStage > 0) this._frostTrail(dt);

        // Footfalls fire regardless of mode; the gait suppresses them while
        // surfing because the feet are on the board.
        const fig = this.figure;
        for (let i = 0; i < 2; i++) {
            let px, pz;
            if (fig) {
                if (!fig.touchdown[i] || !ch.stepping) continue;
                px = fig.plant[i * 3];
                pz = fig.plant[i * 3 + 2];
            } else {
                if (!ch.footfall || i !== ch.footIndex) continue;
                px = ch.footPos.x;
                pz = ch.footPos.z;
            }

            // Recomputed here rather than read off the controller, so it cannot
            // be a frame stale relative to the plant it is describing.
            const impact = Math.min(1.3, 0.35 + ch.speed / 5.4);
            f.brush(
                px, pz,
                BOOT_WIDTH,
                // Depth: a boot sinks 13-27 cm into unpacked snow depending on
                // how hard it lands. Deeper than that and the character is
                // wading, which is a different animation problem.
                0.17 + 0.14 * impact,
                // The berm is the whole point. Mass pushed out of the hole has
                // to go somewhere, and seeing it pile at the rim is what makes
                // the print read as displaced snow rather than as a dark decal.
                0.10 + 0.08 * impact,
                0.9,                    // compression: trodden snow is dense
                0,                      // no ice
                ch.facing,
                BOOT_ELONG,
                1.0                     // full rim roughness — boots tear edges
            );

            const py = fig ? fig.plant[i * 3 + 1] : ch.position.y;
            this._kick(px, py, pz, impact);
        }
    }

    /**
     * Snow thrown by a boot landing.
     *
     * Fired from the same branch that stamps the print, so the grains leave the
     * ground on the exact frame the foot arrives — one event, rather than two
     * systems agreeing about when it happened.
     *
     * The kick goes up and *backward* relative to travel. A boot in deep snow
     * scoops: it enters forward, compresses, and throws the displaced snow out
     * behind the heel as the weight rolls over it.
     */
    _kick(x, y, z, impact) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        if (ch.speed < 0.4) return;

        const fx = Math.sin(ch.facing);
        const fz = Math.cos(ch.facing);
        // Many small grains rather than a few large ones. The size at which a
        // puff stops reading as powder and starts reading as a cotton ball is
        // somewhere around five centimetres, and it is a hard threshold.
        const n = 6 + ((impact * 14) | 0);

        for (let k = 0; k < n; k++) {
            const spread = 0.9;
            const rx = (Math.random() - 0.5) * spread;
            const rz = (Math.random() - 0.5) * spread;
            const up = 0.9 + Math.random() * 1.9;
            const back = 0.5 + Math.random() * 1.6 * impact;
            // A fifth of it is heavier stuff that flies further and falls faster.
            const clod = Math.random() < 0.22 ? 1 : 0;

            sp.emit(
                x + rx * 0.09, y + 0.03 + Math.random() * 0.05, z + rz * 0.09,
                -fx * back + rx * 1.3 + ch.velocity.x * 0.25,
                up * (clod ? 1.25 : 1.0),
                -fz * back + rz * 1.3 + ch.velocity.z * 0.25,
                clod ? 0.014 + Math.random() * 0.012 : 0.020 + Math.random() * 0.030,
                clod ? 0.55 + Math.random() * 0.35 : 0.55 + Math.random() * 0.60,
                clod
            );
        }
    }

    /**
     * Touchdown from a jump.
     *
     * Both feet arrive together and carry the whole body weight, so this is one
     * wide crater rather than two boot prints — deeper and more thrown mass than
     * any single step, scaled by how hard the landing was. The gait is
     * suppressed in the air, so nothing else stamps here.
     */
    _land() {
        const ch = this.character;
        const k = ch.landImpact;

        this.field.brush(
            ch.position.x, ch.position.z,
            BOOT_WIDTH * (1.7 + 0.9 * k),
            0.20 + 0.34 * k,        // depth
            0.14 + 0.24 * k,        // the rim takes what the crater displaces
            1.0,                    // both boots pack it hard
            0,                      // no ice
            ch.facing,
            1.25,                   // nearly round: two feet side by side
            1.0
        );

        this._burst(ch.position.x, ch.position.y, ch.position.z, 0.35 + 0.85 * k);
    }

    /**
     * The ring of snow a landing throws.
     *
     * Radially outward rather than backward — a landing displaces snow in every
     * direction at once, which is what separates it visually from the scooped,
     * rearward kick of a stride.
     */
    _burst(x, y, z, strength) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        const n = 12 + ((strength * 40) | 0);

        for (let i = 0; i < n; i++) {
            const a = Math.random() * Math.PI * 2;
            const out = (0.7 + Math.random() * 2.4) * strength;
            const clod = Math.random() < 0.18 ? 1 : 0;
            const ca = Math.cos(a);
            const sa = Math.sin(a);

            sp.emit(
                x + ca * 0.11, y + 0.02 + Math.random() * 0.06, z + sa * 0.11,
                // Carried along by whatever the character was doing: landing out
                // of a surf run throws the ring forward with it.
                ca * out + ch.velocity.x * 0.3,
                (0.5 + Math.random() * 1.7) * (0.5 + strength) * (clod ? 1.2 : 1.0),
                sa * out + ch.velocity.z * 0.3,
                clod ? 0.014 + Math.random() * 0.012 : 0.020 + Math.random() * 0.030,
                0.5 + Math.random() * 0.75,
                clod
            );
        }
    }

    /**
     * A sword strike that reaches the snow.
     *
     * Only if the point is actually near the surface. That gate is the whole
     * design: a slash held high leaves nothing, a low one opens a clean narrow
     * cut and throws a fan of powder off the edge, and the player learns the
     * difference in one swing without being told. The cut is much narrower and
     * shallower than a boot print and it compresses hard — this is an edge parting
     * snow, not a body displacing it.
     */
    _slash() {
        const ch = this.character;
        const sw = this.sword;
        if (!sw) return;

        sw.tipPosition(_tip);
        const ground = ch.terrain.heightAt(_tip.x, _tip.z);
        const clearance = _tip.y - ground;
        // Above this the blade never touched anything.
        if (clearance > SLASH_REACH) return;

        // Deeper the further through the snow the point actually is, and the
        // heavier the attack behind it.
        const bite = clamp01(1 - clearance / SLASH_REACH) * (0.4 + 0.6 * ch.slashStrength);

        this.field.brush(
            _tip.x, _tip.z,
            SLASH_WIDTH,
            0.22 + 0.30 * bite,     // depth
            0.06 + 0.10 * bite,     // very little berm: an edge parts, it does not plough
            1.0,                    // and it packs the walls of the cut hard
            0,                      // no ice
            ch.facing + Math.PI * 0.5, // across the swing, which is across the body
            SLASH_ELONG,
            0.7
        );

        this._fan(_tip.x, ground, _tip.z, bite, ch.slashStrength);
    }

    /**
     * The powder a cutting edge throws.
     *
     * Sideways and up along the swing rather than backward like a boot: the snow
     * leaves along the blade, which is what makes a slash read as a slash and not
     * as a footfall in the wrong place.
     */
    _fan(x, y, z, bite, strength) {
        const sp = this.spray;
        if (!sp) return;
        const ch = this.character;
        const n = 10 + ((bite * 30 + strength * 16) | 0);

        // Across the body: the direction the edge is travelling.
        const ax = Math.cos(ch.facing);
        const az = -Math.sin(ch.facing);

        for (let i = 0; i < n; i++) {
            const spread = (Math.random() - 0.5) * 1.4;
            const out = 1.4 + Math.random() * 3.6 * (0.4 + bite);
            const clod = Math.random() < 0.14 ? 1 : 0;

            sp.emit(
                x + ax * spread * 0.10, y + 0.03 + Math.random() * 0.10, z + az * spread * 0.10,
                ax * out + spread * 1.2 + ch.velocity.x * 0.25,
                (1.2 + Math.random() * 2.2) * (0.5 + bite),
                az * out + spread * 1.2 + ch.velocity.z * 0.25,
                clod ? 0.012 + Math.random() * 0.010 : 0.016 + Math.random() * 0.026,
                0.45 + Math.random() * 0.6,
                clod
            );
        }
    }

    /**
     * The front foot taking the weight of a strike.
     *
     * Deeper and wider than a walking print, because it is not a step — it is the
     * whole body's momentum arriving through one boot. The figure knows where that
     * foot is; asking it is how this stays in the same place as the pose rather
     * than near it.
     */
    _stomp() {
        const ch = this.character;
        const fig = this.figure;
        if (!fig) return;

        // Foot 0 is the leading one in the fighting stance.
        const px = fig.plant[0];
        const py = fig.plant[1];
        const pz = fig.plant[2];
        const k = 0.55 + 0.45 * ch.slashStrength;

        this.field.brush(
            px, pz,
            BOOT_WIDTH * (1.1 + 0.35 * k),
            0.20 + 0.24 * k,
            0.12 + 0.18 * k,
            1.0,
            0,
            ch.facing,
            BOOT_ELONG,
            1.0
        );
        this._kick(px, py, pz, 0.6 + 0.8 * k);
    }

    /**
     * Frost shed off the blade, keyed to how far the point actually moved.
     *
     * Not an effect on top of the animation — the readable part of it. There is no
     * per-object motion blur here, so an exponential sweep that crosses half its
     * arc in the last three frames has nothing joining up the poses it passes
     * through. Grains laid *along the segment the tip travelled* do that job: they
     * fill the gap between frames, which is what motion blur would have done, and
     * the eye follows them instead of seeing the blade teleport.
     *
     * Driven off the measured tip displacement rather than off the swing phase.
     * That is the whole reason this works now: with the lag chain, the hips have
     * finished and the phase looks static at exactly the moment the blade is
     * travelling fastest, so anything keyed to the phase emits at the wrong time.
     *
     * @param {number} dt
     */
    _frostTrail(dt) {
        const sp = this.spray;
        const sw = this.sword;
        if (!sp || !sw) return;
        const ch = this.character;

        sw.tipPosition(_tip);
        if (!this._tipInit) {
            this._prevTip.copyFrom(_tip);
            this._tipInit = true;
            return;
        }
        const bx = this._prevTip.x - _tip.x;
        const by = this._prevTip.y - _tip.y;
        const bz = this._prevTip.z - _tip.z;
        const moved = Math.hypot(bx, by, bz);
        this._prevTip.copyFrom(_tip);

        // A walking carry moves the point a centimetre or two a frame; a strike
        // moves it most of a metre. Only the second one is a trail, and the trail
        // itself scales with the speed: more grains (length), and bigger ones
        // (brightness), off a faster edge.
        if (moved < 0.07) return;
        const speedK = Math.min(1, (moved - 0.07) / 0.45);

        // Denser and coarser than it was. These grains had been trimmed small and
        // short-lived while they were the *only* thing marking a swing, and once a lit
        // ribbon was drawn over the same arc they disappeared underneath it. They are
        // the matter thrown off the edge and the ribbon is the light left behind it;
        // both have to be legible or the swing loses half of what it is made of.
        const n = Math.min(18, Math.ceil(moved / 0.032));
        for (let i = 0; i < n; i++) {
            // Along the blade, weighted to the outer half where the speed is.
            sw.bladePoint(0.5 + 0.5 * Math.random(), _blade);
            // And back along the path it swept, which fills the frame gap.
            const f = (i + Math.random()) / n;
            sp.emit(
                _blade.x + bx * f + (Math.random() - 0.5) * 0.06,
                _blade.y + by * f + (Math.random() - 0.5) * 0.06,
                _blade.z + bz * f + (Math.random() - 0.5) * 0.06,
                // Almost no velocity of their own: these mark where the edge was,
                // and grains that fly read as spray rather than as a trail.
                (Math.random() - 0.5) * 0.5 + ch.velocity.x * 0.2,
                0.12 + Math.random() * 0.30,
                (Math.random() - 0.5) * 0.5 + ch.velocity.z * 0.2,
                (0.015 + Math.random() * 0.024) * (0.85 + 0.6 * speedK),
                (0.34 + Math.random() * 0.36) * (0.85 + 0.5 * speedK),
                0,
                // Hang, rather than settle. The default drag is tuned for powder
                // falling out of the air; this wants to sit still and fade.
                8.0
            );
        }
    }

    /**
     * Walking scuff. Very shallow, and only while actually moving — a standing
     * character should not slowly bore a hole.
     */
    _walk(dt, moved) {
        const ch = this.character;
        if (ch.speed < 0.25) return;

        const w = 1 - ch.surf;
        // Scaled by distance travelled, not by dt, so the groove has the same
        // depth per metre at any speed or frame rate. A given patch of ground
        // sits under the brush for (2 * radius / moved) frames, so the depth it
        // ends up at is roughly rate * 2 * radius * profile — independent of
        // both speed and frame rate, which is the point.
        const k = Math.min(moved, 0.35);
        // Compression stays deliberately below saturation here. If the scuff
        // packed the whole path to 1.0, the boot prints stamped on top would
        // have nothing left to darken and the trail would read as one flat
        // ribbon instead of as a line of prints in a churned path.
        // Shallower and narrower than the boot prints it links, on purpose. It
        // was originally deep enough to dominate them, which turned a line of
        // footprints into one continuous ski track — fine while the feet were
        // hidden under a floor-length robe, wrong now that they are not.
        this.field.brush(
            ch.position.x, ch.position.z,
            0.22,
            0.20 * k * w,
            0.22 * k * w,
            0.8 * k * w,
            0,
            ch.facing,
            1.5,
            0.85
        );
    }

    /**
     * The surf wake.
     *
     * Three brushes: the groove the board cuts, and one berm on each side
     * weighted by the carve, so the outside of a turn throws a much heavier wall
     * of snow than the inside. That asymmetry is what makes a carve read as a
     * carve rather than as a straight furrow.
     */
    _surf(dt, moved) {
        const ch = this.character;
        const f = this.field;
        const s = ch.surf;

        // Below a walking pace there is no wake to speak of; splatting anyway
        // would just dig a pit wherever the player coasted to a stop.
        const speedK = Math.min(1, ch.speed / 6);
        if (speedK < 0.05) return;

        const k = Math.min(moved, 0.6) * s * speedK;
        if (k <= 0) return;

        // Past the point where the trench stops deepening, extra speed still
        // means extra snow moved — it goes into width and into the walls, which
        // is what makes a fast run's scar read as bigger rather than just longer.
        const fast = Math.min(1, Math.max(0, ch.speed - 6) / 12);

        const yaw = ch.facing;
        const rx = Math.cos(yaw);
        const rz = -Math.sin(yaw);

        // --- the groove ------------------------------------------------------
        // The board rides the inside edge in a turn, so the trench offsets
        // slightly toward the lean.
        const lean = ch.carve;
        const gx = ch.position.x + rx * lean * 0.12;
        const gz = ch.position.z + rz * lean * 0.12;

        f.brush(
            gx, gz,
            SURF_WIDTH * (1 + 0.35 * fast),
            1.20 * k,   // deep — a run should be visible from across the field
            0.30 * k,
            4.0 * k,    // the board packs the trench floor hard
            0,
            yaw,
            SURF_ELONG,
            0.55        // the board's edge is cleaner than a boot's
        );

        // --- thrown mass -----------------------------------------------------
        // The outside of the turn takes most of it, and the outside of a *right*
        // turn is the left-hand side — the board resists the turn and throws snow
        // away from its centre, the same way a carving snowboard's spray arcs out
        // of the turn rather than into it. `carve` is positive turning right, so
        // the weights run against it.
        //
        // The wake mesh in `src/vfx/surfWake.js` resolves its sides from the same
        // sign, so the airborne wave and the mark it leaves agree.
        const outside = Math.min(1, Math.abs(lean));
        const sideL = 0.5 + lean * 0.5; // weight on the left berm
        const sideR = 0.5 - lean * 0.5;

        const off = SURF_WIDTH * (1.5 + 0.5 * fast);
        const throwK = 0.75 * k * (0.55 + 0.9 * outside) * (1 + 0.5 * fast);

        f.brush(
            ch.position.x - rx * off, ch.position.z - rz * off,
            SURF_WIDTH * 0.95,
            0, throwK * sideL * 2.0, 0, 0,
            yaw, SURF_ELONG * 0.8, 1.0
        );
        f.brush(
            ch.position.x + rx * off, ch.position.z + rz * off,
            SURF_WIDTH * 0.95,
            0, throwK * sideR * 2.0, 0, 0,
            yaw, SURF_ELONG * 0.8, 1.0
        );
    }
}
