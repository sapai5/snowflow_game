/**
 * Scripted players, for measuring and for fighting.
 *
 * Two jobs, and the second one is why this survived Phase 0 rather than being
 * deleted with it:
 *
 *   1. It prices a crowd. The expensive part of a character is its cloth solve —
 *      1728 Verlet particles at up to six iterations, per player, on the CPU — and
 *      the plan needed that measured rather than assumed before committing to four
 *      players and a set of detail tiers. `cpu players` in the overlay is the answer.
 *   2. It is the practice dummy. These are real `Player` instances, driven by a
 *      written intent instead of by input, so once combat exists they will take
 *      damage, parry and die exactly as a networked player will. Nothing about them
 *      is a mock; the only difference between one of these and a remote player is
 *      *who writes the intent*.
 *
 * That is the seam the whole multiplayer plan hangs off: a driver writes intents, the
 * simulation does not care where they came from.
 */

import { makeIntent } from "../game/intent.js";
import { SPELLS } from "../game/combat.js";

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

/**
 * How close they try to get, metres.
 *
 * Inside the player's reach, which is about 1.48 m from body centre to blade tip once
 * the carry tilt is accounted for. This was 1.25 with a strafe that outweighed the
 * approach, so they settled into an orbit at just under two metres — comfortably
 * outside that reach, which is why they were so hard to hit. A practice dummy has to
 * stand somewhere you can actually reach it.
 */
const ENGAGE_RANGE = 1.1;
/** Beyond this they walk straight at you; inside it they circle and strike. */
const CIRCLE_RANGE = 3.0;
/** Seconds between a dummy's attacks once it is in range. */
const ATTACK_PERIOD = 1.6;

/**
 * The minimum a dummy waits between its own casts, seconds.
 *
 * Each spell has a 45 second cooldown, which limits how often any *one* of them comes
 * back — and does nothing to stop a dummy emptying all five in the first twelve
 * seconds of a fight, which is what it did. Five different spells in quick succession
 * is still spam even when every individual cooldown is honoured, so the loadout needs
 * a rate limit of its own.
 *
 * Ten seconds means a dummy casts perhaps twice in a fight, which is the point: the
 * sword should be the conversation and a spell should be an interruption to it.
 */
const CAST_MIN_GAP = 10;
/**
 * How soon to look again after finding nothing worth casting — everything on cooldown,
 * or the only ready spell wrong for this range. Short, so a dummy that walks into
 * range does not stand there for ten seconds holding a spell it could have used.
 */
const CAST_RETRY = 1.5;
const CAST_RANGE = 18;

export class DummyCrowd {
    /**
     * @param {import("../game/world.js").World} world
     * @param {import("../render/depthPass.js").DepthPass} [depth]
     */
    constructor(world, depth) {
        this.world = world;
        this.depth = depth;
        /** @type {{player: any, intent: any, nextSwing: number}[]} */
        this.driven = [];
        this._fwd = new Vector3();
        this._right = new Vector3();
        this._to = new Vector3();
        this._aim = new Vector3();
        this._at = new Vector3();
    }

    /**
     * Grow or shrink the crowd.
     *
     * Built lazily, so a session that never asks for dummies never pays for them —
     * including the shader warm-up, which is why the first spawn hitches.
     *
     * @param {number} n
     */
    setCount(n) {
        const want = Math.max(0, Math.min(7, Math.round(n)));
        while (this.driven.length > want) {
            const d = this.driven.pop();
            this.world.despawn(d.player.id);
        }
        while (this.driven.length < want) {
            const i = this.driven.length;
            const player = this.world.spawn({ name: "dummy " + (i + 1) });
            if (this.depth) {
                player.figure.registerPrepass(this.depth);
                player.sword.registerPrepass(this.depth);
            }
            // Staggered, so three of them do not swing on the same frame forever.
            this.driven.push({
                player,
                intent: makeIntent(),
                nextSwing: 1.2 + i * 0.4,
                // Offset well apart, so three dummies do not all open with a spell in
                // the same second the fight starts.
                nextCast: 4 + i * 3.5,
            });
        }
    }

    /**
     * Write this frame's intents.
     *
     * Called before `World.update`, because that is where they are consumed.
     *
     * The behaviour is the smallest thing that makes them a sparring partner rather
     * than scenery: walk at you until you are inside blade reach, then circle and
     * swing on a timer. An earlier version had them orbit at nine metres, which
     * measured the cost of four characters perfectly well and could never land a
     * hit — and a practice dummy that cannot hit back is a target. What the combat
     * rules need testing against is being *hit*.
     *
     * Movement is written as an intent rather than as a position, so the real
     * controller does the moving: they accelerate, they turn at their own rate, they
     * walk up dunes, and a Wave slows them exactly as it would slow a player.
     *
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    drive(dt, rig) {
        if (this.driven.length === 0) return;

        const me = this.world.local;
        // The controller reads movement as camera-relative, because that is what a
        // player's keys mean. A dummy's target is a world direction, so it has to be
        // expressed in the same basis or "toward you" comes out rotated by wherever
        // the camera happens to be pointing.
        rig.getFlatForward(this._fwd);
        rig.getFlatRight(this._right);

        for (let i = 0; i < this.driven.length; i++) {
            const d = this.driven[i];
            const it = d.intent;
            const ch = d.player.controller;

            it.moveX = 0;
            it.moveZ = 0;
            it.attackPressed = false;
            it.jumpPressed = false;
            it.jump = false;
            it.surf = false;
            it.sprint = false;
            it.faceYaw = null;
            it.aimYaw = null;
            d.player.intent = it;

            if (!me || !me.alive || !d.player.alive) continue;

            this._to.copyFrom(me.controller.position).subtractInPlace(ch.position);
            this._to.y = 0;
            const dist = this._to.length();
            if (dist > 0.001) this._to.scaleInPlace(1 / dist);

            // Point at the target rather than at the sidestep. Without this they face
            // their own movement, which while circling means the blade sweeps the air
            // beside you and a dummy standing a metre away can never land a hit.
            const toTarget = Math.atan2(this._to.x, this._to.z);
            it.aimYaw = toTarget;
            if (dist < CIRCLE_RANGE) it.faceYaw = toTarget;

            let wx = this._to.x;
            let wz = this._to.z;
            if (dist < CIRCLE_RANGE) {
                // In range: sidestep around you rather than standing still, so a fight
                // is not two figures pressed together. The direction alternates per
                // dummy so they do not all crowd the same shoulder.
                // Approach dominates the sidestep rather than the other way round. The
                // circling is there so a fight is not two figures pressed together; it
                // is not there to keep them out of reach.
                const side = i % 2 === 0 ? 1 : -1;
                const close = dist > ENGAGE_RANGE ? 1.0 : -0.35;
                wx = -this._to.z * side * 0.42 + this._to.x * close;
                wz = this._to.x * side * 0.42 + this._to.z * close;
            } else {
                it.sprint = dist > 8;
            }

            const l = Math.hypot(wx, wz) || 1;
            wx /= l;
            wz /= l;
            it.moveX = wx * this._right.x + wz * this._right.z;
            it.moveZ = wx * this._fwd.x + wz * this._fwd.z;

            // Swing when they can reach. The blade is about a metre, so a little
            // beyond the engage range still connects on the follow-through.
            d.nextSwing -= dt;
            if (dist < ENGAGE_RANGE + 0.9 && d.nextSwing <= 0) {
                it.attackPressed = true;
                d.nextSwing = ATTACK_PERIOD * (0.75 + Math.random() * 0.5);
            }

            d.nextCast -= dt;
            if (d.nextCast <= 0 && dist < CAST_RANGE) {
                // The gap is measured from the last *cast*, not from the last look. A
                // dummy that found nothing ready checks again soon; one that actually
                // spent a spell waits.
                d.nextCast = this._tryCast(d, me, dist) ? CAST_MIN_GAP : CAST_RETRY;
            }
        }
    }

    /**
     * Spend a spell, if any are ready.
     *
     * Both halves are fired here — the gameplay volume through the combat resolver and
     * the visual through the spell system — because the two are separate systems by
     * design and a caster is responsible for asking both. The resolver refuses if the
     * spell is on cooldown, staggered or dead, and it is asked *first* so a refused
     * cast never plays a picture of something that did not happen.
     *
     * @param {{player: any, nextCast: number}} d
     * @param {any} target
     * @param {number} dist
     * @returns {boolean} whether a spell was actually spent
     */
    _tryCast(d, target, dist) {
        const p = d.player;
        const world = this.world;

        // Shuffle the order they are tried in, so a dummy is not forever a Wave
        // specialist that only reaches for the others when Wave is spent.
        const order = [1, 2, 3, 4, 5];
        for (let i = order.length - 1; i > 0; i--) {
            const j = (Math.random() * (i + 1)) | 0;
            const t = order[i];
            order[i] = order[j];
            order[j] = t;
        }

        for (let k = 0; k < order.length; k++) {
            const id = order[k];
            const spell = SPELLS[id];
            if (!spell || !p.spellReady(id, world.now)) continue;

            // Only reach for what makes sense at this distance. Not tactics — just
            // enough that a Vortex is not cast at a target fifteen metres away, which
            // would look like a bug rather than like a decision.
            if (spell.kind === "burst" && dist > spell.radius) continue;
            if (spell.kind === "cone" && dist > spell.range) continue;

            this._aim.copyFrom(target.controller.position).subtractInPlace(p.controller.position);
            this._aim.y = 0;
            if (this._aim.lengthSquared() < 1e-6) return false;
            this._aim.normalize();

            // Placed spells land on the target; the rest come off the caster.
            const placed = spell.kind === "sphere" || spell.kind === "field";
            if (placed) {
                this._at.copyFrom(target.controller.position);
            } else {
                this._at.copyFrom(p.controller.position);
                this._at.y += 1.4;
            }
            const origin = placed ? this._at : this._at;

            if (!world.combat.cast(p, id, origin, this._aim)) continue;

            // Camera shake, scaled by how far away it happened. A spell across the
            // field should be seen and not felt.
            const near = Math.max(0, 1 - dist / 22);
            world.spellFx?.castAs(id, p.controller, this._aim, this._at, 0.10 * near * near);
            return true;
        }
        return false;
    }

    get count() {
        return this.driven.length;
    }
}
