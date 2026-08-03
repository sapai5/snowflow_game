/**
 * Third-person spring-arm rig — anchored over-the-shoulder framing.
 *
 * The arm is stiff on purpose. The character holds a fixed place in frame and
 * the reticle at screen centre means what it points at, which is what every
 * third-person action game does and what a soft spring cannot give you: a rig
 * that lags the character makes the world feel like it is sliding around the
 * player rather than the player moving through it.
 *
 * Two rates rather than one spring, and no overshoot in either. Horizontal is
 * nearly rigid — 24/s is about four frames to close 90% of a gap, which reads as
 * attached. Vertical is deliberately half that: the ground under this character
 * is dunes, and a rig that tracks every crest rigidly bobs the whole view.
 *
 * FOV widens with speed and the rig banks into a carve, but both are a third of
 * what they were when this was a free-flying showcase rig — enough to feel the
 * speed, not enough to feel unmoored.
 *
 * Open snow field, so there is no obstacle collision solve — only the ground
 * itself pushes the arm up, which buys a rig that never pops through a drift.
 */

import { Vector3, Matrix, Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Scalar } from "@babylonjs/core/Maths/math.scalar";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { input } from "./input.js";

// ------------------------------------------------------- module-scope scratch
const _pivot = new Vector3();
const _desired = new Vector3();
const _fwd = new Vector3();
const _right = new Vector3();
const _up = new Vector3();
const _tmp = new Vector3();

/** Height probes taken along the spring arm each frame. */
const ARM_SAMPLES = 5;

const PITCH_MIN = -0.62; // looking up
const PITCH_MAX = 1.05; // looking down
const DIST_MIN = 1.9;
const DIST_MAX = 8.0;

/**
 * How fast the pivot closes on the character, per axis, 1/s.
 *
 * Horizontal is high enough to read as anchored and low enough that a frame
 * spike does not snap the view. Vertical is much lower on purpose — see the note
 * at the top of the file.
 */
const PIVOT_RATE_XZ = 24;
const PIVOT_RATE_Y = 11;

export class CameraRig {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {HTMLCanvasElement} canvas
     */
    constructor(scene, canvas) {
        const cam = new UniversalCamera("cam", new Vector3(0, 3, -6), scene);
        cam.minZ = 0.12;
        cam.maxZ = 4200;
        cam.fov = 1.02; // ~58deg vertical
        cam.inertia = 0;
        cam.rotation.set(0, 0, 0);
        // No attachControl — this rig drives the transform itself.

        this.camera = cam;
        this.scene = scene;

        this.yaw = 2.4;
        this.pitch = 0.17;

        this.distance = 3.6;
        this.distanceTarget = 3.6;

        /** Smoothed pivot position (the thing the arm hangs off). */
        this.pivot = new Vector3(0, 0, 0);

        /**
         * Over-the-shoulder offset, in camera space, and the height the arm
         * pivots about.
         *
         * Together these are the framing: the shoulder offset is what puts the
         * character left of centre and leaves the middle of the screen — where
         * the reticle is — looking at what they are facing. The pivot height is
         * chest-high on a 1.7 m figure, not eye-high, so the horizon sits where a
         * third-person camera puts it rather than where a headcam would.
         */
        this.shoulder = 0.55;
        this.pivotHeight = 1.45;

        this.baseFov = 1.02;
        this.fov = 1.02;

        this.roll = 0;
        this.rollTarget = 0;

        /**
         * The rig's basis, republished every frame. The spells aim with the
         * same three vectors, so there is only one place the convention for
         * "forward" is written down.
         */
        this.forward = new Vector3(0, 0, 1);
        this.right = new Vector3(1, 0, 0);
        this.up = new Vector3(0, 1, 0);

        // Trauma-based shake (Squirrel Eiserloh style): shake = trauma^2, so it
        // falls off perceptually rather than linearly.
        this.trauma = 0;
        this.shakeTime = 0;

        /**
         * Height sampler, injected once the terrain exists.
         * @type {((x:number, z:number) => number)|null}
         */
        this.groundAt = null;
        /** Metres of snow the camera must keep beneath it. */
        this.groundClearance = 1.0;
        /** Eased lift currently being applied to stay above the surface. */
        this.groundLift = 0;

        this._first = true;
    }

    /** @param {number} amount 0..1 */
    addTrauma(amount) {
        this.trauma = Math.min(1, this.trauma + amount);
    }

    /**
     * @param {number} dt seconds
     * @param {Vector3} targetPos character world position (feet)
     * @param {Vector3} targetVel character world velocity
     * @param {number} lean signed lean amount, -1..1, for banking
     * @param {number} speed01 normalised speed for FOV widening
     */
    update(dt, targetPos, targetVel, lean, speed01) {
        // ------------------------------------------------------------- look
        this.yaw += input.lookX;
        this.pitch = Scalar.Clamp(this.pitch + input.lookY, PITCH_MIN, PITCH_MAX);

        // ------------------------------------------------------------- zoom
        this.distanceTarget = Scalar.Clamp(
            this.distanceTarget + input.zoomDelta * (this.distanceTarget * 0.35),
            DIST_MIN,
            DIST_MAX
        );
        // Eased zoom — expDamp is framerate-independent.
        this.distance = expDamp(this.distance, this.distanceTarget, 9, dt);

        // ------------------------------------------------------------ pivot
        _pivot.copyFrom(targetPos);
        _pivot.y += this.pivotHeight;

        // Lead only at real speed. Leading at a walk is what made the rig feel
        // like it was drifting: the character wandered around in frame while the
        // player was doing nothing but strolling.
        const lead = Math.max(0, speed01 - 0.4) * 0.9;
        _pivot.x += targetVel.x * lead * 0.05;
        _pivot.z += targetVel.z * lead * 0.05;

        if (this._first) {
            this.pivot.copyFrom(_pivot);
            this._first = false;
        } else {
            // Exponential rather than a spring, so it cannot overshoot, and split
            // per axis so the horizontal can be stiff without the vertical
            // tracking every dune.
            this.pivot.x = expDamp(this.pivot.x, _pivot.x, PIVOT_RATE_XZ, dt);
            this.pivot.z = expDamp(this.pivot.z, _pivot.z, PIVOT_RATE_XZ, dt);
            this.pivot.y = expDamp(this.pivot.y, _pivot.y, PIVOT_RATE_Y, dt);
        }

        // -------------------------------------------------------------- fov
        const fovWant = this.baseFov * (1 + speed01 * 0.12);
        this.fov = expDamp(this.fov, fovWant, 3.2, dt);

        // ------------------------------------------------------------- bank
        this.rollTarget = -lean * 0.03;
        this.roll = expDamp(this.roll, this.rollTarget, 5.0, dt);

        // ------------------------------------------------------------ shake
        this.trauma = Math.max(0, this.trauma - dt * 1.15);
        this.shakeTime += dt;
        const shake = this.trauma * this.trauma;

        // ------------------------------------------------------ compose xform
        const cp = Math.cos(this.pitch);
        _fwd.set(
            Math.sin(this.yaw) * cp,
            -Math.sin(this.pitch),
            Math.cos(this.yaw) * cp
        );
        _right.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        Vector3.CrossToRef(_right, _fwd, _up);
        _up.normalize();

        this.forward.copyFrom(_fwd);
        this.right.copyFrom(_right);
        this.up.copyFrom(_up);

        _desired.copyFrom(this.pivot);
        _desired.addInPlace(_tmp.copyFrom(_fwd).scaleInPlace(-this.distance));
        _desired.addInPlace(_tmp.copyFrom(_right).scaleInPlace(this.shoulder));
        _desired.addInPlace(_tmp.copyFrom(_up).scaleInPlace(0.12));

        // ---- keep the arm out of the snow --------------------------------
        // The lift rises quickly and relaxes slowly: snapping down the instant a
        // crest passes under the arm reads as a jolt, while being slow to rise
        // means a frame or two actually inside the snow.
        if (this.groundAt) {
            // Worst case over the whole arm, not just the eye: a crest between
            // the player and the camera can fill the view while the eye itself
            // is legally above the snow.
            let need = 0;
            for (let i = 0; i <= ARM_SAMPLES; i++) {
                const t = i / ARM_SAMPLES;
                const x = this.pivot.x + (_desired.x - this.pivot.x) * t;
                const z = this.pivot.z + (_desired.z - this.pivot.z) * t;
                const y = this.pivot.y + (_desired.y - this.pivot.y) * t;
                // Clearance eases in along the arm so it does not shove the
                // camera up merely for being near the player's own feet.
                const gh = this.groundAt(x, z) + this.groundClearance * (0.35 + 0.65 * t);
                const d = gh - y;
                if (d > need) need = d;
            }

            this.groundLift = expDamp(
                this.groundLift, need, need > this.groundLift ? 26 : 4.5, dt
            );
            _desired.y += this.groundLift;
        }

        if (shake > 0.0001) {
            const t = this.shakeTime * 26;
            _desired.x += (noise1(t) * 2 - 1) * shake * 0.16;
            _desired.y += (noise1(t + 31.7) * 2 - 1) * shake * 0.16;
            _desired.z += (noise1(t + 71.3) * 2 - 1) * shake * 0.10;
        }

        const cam = this.camera;
        cam.position.copyFrom(_desired);
        cam.fov = this.fov;
        cam.rotation.set(
            this.pitch + (shake > 0.0001 ? (noise1(this.shakeTime * 31 + 11) * 2 - 1) * shake * 0.02 : 0),
            this.yaw + (shake > 0.0001 ? (noise1(this.shakeTime * 29 + 53) * 2 - 1) * shake * 0.02 : 0),
            this.roll + (shake > 0.0001 ? (noise1(this.shakeTime * 23 + 97) * 2 - 1) * shake * 0.05 : 0)
        );
    }

    /** Flat camera-space forward on the XZ plane, for movement. Writes to `out`. */
    getFlatForward(out) {
        out.set(Math.sin(this.yaw), 0, Math.cos(this.yaw));
        return out;
    }

    getFlatRight(out) {
        out.set(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
        return out;
    }
}

// ------------------------------------------------------------------ helpers

/** Framerate-independent exponential approach. */
export function expDamp(cur, target, rate, dt) {
    return target + (cur - target) * Math.exp(-rate * dt);
}

/**
 * Semi-implicit damped spring toward `target`, mutating `pos` and `vel`.
 *
 * Unused by the rig itself — the pivot moved to a non-overshooting exponential
 * when the framing was anchored — and kept because a spring is the right tool
 * the moment anything here needs to *overshoot* on purpose.
 *
 * @param {Vector3} pos @param {Vector3} vel @param {Vector3} target
 * @param {number} freq natural frequency (rad/s-ish)
 * @param {number} damping 1 = critical
 */
export function springDamp(pos, vel, target, freq, damping, dt) {
    const k = freq * freq;
    const c = 2 * damping * freq;
    // Clamp dt so a hitch can't blow the integrator up.
    const h = Math.min(dt, 1 / 45);
    vel.x += (k * (target.x - pos.x) - c * vel.x) * h;
    vel.y += (k * (target.y - pos.y) - c * vel.y) * h;
    vel.z += (k * (target.z - pos.z) - c * vel.z) * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;
}


/** Cheap smooth 1D value noise for shake. Deterministic, no allocation. */
function noise1(x) {
    const i = Math.floor(x);
    const f = x - i;
    const u = f * f * (3 - 2 * f);
    return hash1(i) * (1 - u) + hash1(i + 1) * u;
}

function hash1(n) {
    const s = Math.sin(n * 127.1) * 43758.5453;
    return s - Math.floor(s);
}
