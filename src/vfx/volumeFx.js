/**
 * The visible half of a gameplay volume.
 *
 * The combat resolver owns volumes and must stay render-free — it is the module that
 * will run on the authority, in Node, with no GPU anywhere near it. So it produces
 * truth and nothing else, and this reads that truth and draws it.
 *
 * Right now that means one thing: **the Snowball**. It was the only spell whose
 * gameplay had no picture at all — a fifteen-damage blinding projectile crossing
 * twenty metres of snowfield completely invisibly, for every caster including the
 * local player. Wave, Updraft, the crystal field and Vortex all have authored
 * effects; the projectile had a velocity and a hitbox and no photons.
 *
 * It is drawn out of the existing spray pool rather than as a mesh, which is not a
 * shortcut: a snowball *is* a clump of powder, the pool already lights, shadows and
 * sorts its grains against the snow, and a mesh would have needed its own material,
 * its own shadow pass and its own reason to exist. A dozen grains a frame laid along
 * the path gives a dense core with a thinning tail, which is what a thrown handful of
 * snow looks like.
 *
 * Allocation per frame: none.
 */

/** Grains per second at the head of the ball. */
const CORE_RATE = 220;
/** How far behind the head grains are seeded, metres — the tail's length. */
const TAIL = 0.55;

export class VolumeFx {
    /**
     * @param {import("../game/combat.js").CombatResolver} combat
     * @param {import("./particles.js").SprayField} spray
     */
    constructor(combat, spray) {
        this.combat = combat;
        this.spray = spray;
        this._owed = 0;
    }

    /** @param {number} dt */
    update(dt) {
        const sp = this.spray;
        if (!sp) return;

        for (let i = 0; i < this.combat.volumes.length; i++) {
            const v = this.combat.volumes[i];
            if (!v.alive || !v.spell || v.spell.kind !== "projectile") continue;

            // Rate per volume rather than shared, so two snowballs in the air are
            // both dense rather than each half-drawn.
            this._owed += CORE_RATE * dt;
            const n = this._owed | 0;
            this._owed -= n;

            for (let k = 0; k < n; k++) {
                // Spread along the path travelled this frame *and* backward into the
                // tail, so the ball reads as moving even in a single frame of it.
                const back = Math.random() * TAIL;
                const r = 0.09;
                sp.emit(
                    v.pos.x - v.vel.x * back * 0.04 + (Math.random() - 0.5) * r,
                    v.pos.y - v.vel.y * back * 0.04 + (Math.random() - 0.5) * r,
                    v.pos.z - v.vel.z * back * 0.04 + (Math.random() - 0.5) * r,
                    // A fraction of the ball's own velocity, so the tail drifts after
                    // it instead of hanging in a line. Grains that carried the full
                    // velocity outran the ball and arrived first.
                    v.vel.x * 0.18 + (Math.random() - 0.5) * 1.2,
                    v.vel.y * 0.18 + (Math.random() - 0.5) * 1.2 + 0.4,
                    v.vel.z * 0.18 + (Math.random() - 0.5) * 1.2,
                    0.016 + Math.random() * 0.022,
                    0.22 + Math.random() * 0.30,
                    Math.random() < 0.25 ? 1 : 0,
                    // High drag: the tail should stall and fall behind rather than
                    // flying on, which is what separates a trail from a spray.
                    4.5
                );
            }
        }
    }
}
