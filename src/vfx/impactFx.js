/**
 * What a hit looks like.
 *
 * The resolver decides that a hit happened and says where; this is the only thing that
 * makes it *visible*. Before it existed a connected strike and a whiffed one looked
 * identical — the health bar moved, and that was the entire cue. In a fight at four
 * metres, watching a two-pixel bar above someone's head is not feedback.
 *
 * Four cues, on purpose, because one is never enough at speed:
 *
 *   a burst      snow and ice thrown off the contact point, along the blade's travel.
 *                Matter, and the only cue that says *where* on the body it landed.
 *   a flash      one frame of light at the same point, through the spell light pool.
 *                It lights the victim, their robe and the snow under them, which is
 *                what makes a hit feel like it happened in the world rather than on
 *                the screen.
 *   a hitmarker  on the reticle. Utterly conventional and utterly effective: it is the
 *                only cue guaranteed to be where the player is already looking.
 *   the shake    a kick scaled to the weight of the blow.
 *
 * Hit-stop is the fifth, and it belongs to the resolver rather than here, because
 * stopping time is a simulation decision that the animation and the physics both have
 * to agree about.
 *
 * Allocation per frame: none.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/** Grains in a sword-hit burst, and how hard they leave. */
const HIT_GRAINS = 26;
const HIT_SPEED = 4.5;

/** How long the impact light lives, seconds. Two or three frames. */
const FLASH_LIFE = 0.05;

const _at = new Vector3();
const _dir = new Vector3();

export class ImpactFx {
    /**
     * @param {import("../game/world.js").World} world
     * @param {import("./particles.js").SprayField} spray
     * @param {import("../spells/spellLights.js").SpellLights} lights
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {{ hit: (weight: number) => void }} [crosshair]
     */
    constructor(world, spray, lights, rig, crosshair) {
        this.world = world;
        this.spray = spray;
        this.lights = lights;
        this.rig = rig;
        this.crosshair = crosshair || null;

        /** Live impact lights: x, y, z, age, strength. */
        this._flash = new Float32Array(6 * 5);
        this._next = 0;
    }

    /**
     * Read this frame's combat events and answer them.
     *
     * Called after the world has updated and before `World.endFrame` drains the events.
     *
     * @param {number} dt
     */
    update(dt) {
        const events = this.world.combat.events;
        const me = this.world.local;

        for (let i = 0; i < events.length; i++) {
            const e = events[i];
            if (e.x === undefined) continue;

            if (e.kind === "hit") {
                // Heavier stages throw more, and the finisher throws a lot.
                const weight = e.stage >= 3 ? 1 : 0.55;
                this._burst(e, weight, 0.55, 0.9);
                this._light(e, 0.8 + 0.6 * weight);
                if (me && e.by === me.id) {
                    this.crosshair?.hit(weight);
                    this.rig.addTrauma(0.06 + 0.10 * weight);
                }
            } else if (e.kind === "clash") {
                // Sparks rather than snow: two blades meeting throws ice, not powder.
                this._burst(e, 1, 0.95, 1.5);
                this._light(e, 1.6);
                if (me && (e.by === me.id || e.on === me.id)) {
                    this.crosshair?.hit(1);
                    this.rig.addTrauma(0.16);
                }
            } else if (e.kind === "spellHit") {
                this._burst(e, 0.7, 0.4, 0.7);
                this._light(e, 1.1);
                if (me && e.by === me.id) this.crosshair?.hit(0.7);
            }
        }

        this._tickLights(dt);
    }

    /**
     * Snow and ice off the point of contact.
     *
     * Thrown outward from the victim rather than along the blade: the blade's direction
     * is already told by the trail, and a burst that agrees with it adds nothing, where
     * one that sprays outward reads as material being displaced.
     */
    _burst(e, weight, iceShare, speedScale) {
        const sp = this.spray;
        if (!sp) return;
        const n = (HIT_GRAINS * weight) | 0;

        for (let k = 0; k < n; k++) {
            // A cone biased upward and outward. Uniform in a sphere reads as an
            // explosion; biased up reads as something struck.
            const a = Math.random() * Math.PI * 2;
            const up = 0.35 + Math.random() * 0.9;
            const out = 0.5 + Math.random() * 1.0;
            const v = HIT_SPEED * speedScale * (0.4 + Math.random() * 0.8);
            const clod = Math.random() < iceShare ? 1 : 0;

            sp.emit(
                e.x + (Math.random() - 0.5) * 0.12,
                e.y + (Math.random() - 0.5) * 0.16,
                e.z + (Math.random() - 0.5) * 0.12,
                Math.cos(a) * out * v,
                up * v * 0.7,
                Math.sin(a) * out * v,
                clod ? 0.014 + Math.random() * 0.018 : 0.020 + Math.random() * 0.030,
                0.35 + Math.random() * 0.45,
                clod,
                clod ? 1.1 : 3.0
            );
        }
    }

    /**
     * One brief light at the contact point.
     *
     * Borrowed from the spell light pool, which is four slots wide and mostly idle: with
     * a 45 second cooldown on every spell, the pool is empty far more often than not, so
     * an impact can use a slot for three frames without ever meaningfully competing with
     * a spell. A dedicated light path for something this short-lived would be a second
     * copy of code that already exists in every material that answers a light.
     */
    _light(e, strength) {
        const f = this._flash;
        const o = this._next * 5;
        f[o] = e.x;
        f[o + 1] = e.y;
        f[o + 2] = e.z;
        f[o + 3] = 0;
        f[o + 4] = strength;
        this._next = (this._next + 1) % 6;
    }

    _tickLights(dt) {
        const f = this._flash;
        for (let i = 0; i < 6; i++) {
            const o = i * 5;
            if (f[o + 4] <= 0) continue;
            f[o + 3] += dt;
            const t = f[o + 3] / FLASH_LIFE;
            if (t >= 1) {
                f[o + 4] = 0;
                continue;
            }
            // Cold white-blue, and it dies quadratically: a linear fade over three
            // frames still reads as a light turning off rather than as a flash.
            const k = (1 - t) * (1 - t) * f[o + 4];
            this.lights.add(
                f[o], f[o + 1], f[o + 2], 3.2,
                0.72, 0.88, 1.0, 5.5 * k
            );
        }
    }
}
