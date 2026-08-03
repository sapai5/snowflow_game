/**
 * Who hit whom.
 *
 * The one place in the game that decides a hit landed. Everything else either
 * produces the state it reads — poses, blade transforms, cast events — or consumes
 * what it writes — health, effects, knockback, the HUD.
 *
 * Two kinds of hit, resolved differently:
 *
 *   melee   a swept segment against capsules. The blade moves a metre in three
 *           frames, so a point test at frame boundaries misses through people; this
 *           tests the *segment the edge swept* since the last frame, against the
 *           capsule, which cannot tunnel.
 *   volumes cones, projectiles, spheres and fields, spawned by a cast and living for
 *           as long as their spell says. A volume is gameplay, not decoration: the
 *           visual effect is a separate system that happens to look like it, and if
 *           the two ever disagree the volume is right.
 *
 * Parry is not a third kind. It is what happens when two melee windows overlap —
 * see `_resolveMelee`.
 *
 * When the network lands, this module is what runs on the authority. It reads
 * players and writes damage; it touches no rendering and holds no GPU resource, which
 * is deliberate and is what will let it run in Node unchanged.
 *
 * Allocation per frame: none. Volumes come from a fixed pool.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { SLOW, BLIND, AIR_RESTRICT, STAGGER, DOT } from "./effects.js";
import {
    SWORD_DAMAGE, SWORD_KNOCKBACK, BLADE_RADIUS, BODY_RADIUS, BODY_HEIGHT,
    CLASH_STAGGER, SPELLS, SPELL_COOLDOWN, MAX_HEALTH, RESPAWN_TIME,
    FINISHER_STAGGER,
} from "./rules.js";

// Re-exported because callers have always imported them from here, and the spell
// visuals should not have to know where the table physically lives.
export { SPELLS, SPELL_COOLDOWN, MAX_HEALTH, RESPAWN_TIME };

// The balance numbers live in `rules.js`, which the Node authority imports too. Two
// copies of a damage table is how a client comes to show one number while the server
// deducts another.
const MAX_VOLUMES = 24;

const _a = new Vector3();
const _b = new Vector3();
const _d = new Vector3();
const _tmp = new Vector3();
const _hitAt = new Vector3();

/** One live gameplay volume. Pooled; `alive` is the only liveness flag. */
class Volume {
    constructor() {
        this.alive = false;
        this.spell = null;
        this.ownerId = null;
        this.pos = new Vector3();
        this.vel = new Vector3();
        this.dir = new Vector3();
        this.age = 0;
        /**
         * Who has already taken this volume's *impact*.
         *
         * Never cleared for the life of the volume, which is the distinction that
         * matters for a field: its eruption hits you once, and its burn keeps being
         * refreshed for as long as you stand in it. An earlier version cleared this on
         * a timer so the burn would re-apply, and re-applied the 20-point impact along
         * with it — four times a second, for eighty damage a second out of a spell
         * specced at six.
         */
        this.impacted = new Set();
    }
}

export class CombatResolver {
    /**
     * @param {import("./world.js").World} world
     */
    constructor(world) {
        /**
         * Does this resolver own health, death and respawn?
         *
         * True in single player, where there is nobody else to ask. False once a relay is
         * in the picture: the client keeps detecting hits — that is its job under the
         * trusted-client model — but stops applying their consequences and reports them
         * instead.
         */
        this.authoritative = true;

        /**
         * When set, only volumes and blades belonging to this player are resolved.
         *
         * Without it, every client would resolve every blade and every spell, and all
         * four would send a claim for the same hit — a nine damage strike would land as
         * thirty-six. Under "each client does its own hit detection" the corollary is
         * that each client must do *only* its own, and this is that corollary.
         *
         * @type {string|null}
         */
        this.ownerId = null;
        this.world = world;
        /** @type {Volume[]} */
        this.volumes = [];
        for (let i = 0; i < MAX_VOLUMES; i++) this.volumes.push(new Volume());

        /** Last frame's blade tip and guard, per player, for the swept segment. */
        this._prevBlade = new Map();
        /**
         * What happened this frame: hits, clashes, parries, casts, deflections, deaths.
         *
         * Drained by consumers rather than cleared by the producer, and that is not a
         * style preference. Casting happens *outside* this module — a player's input or
         * an NPC's decision, both of which run before the resolver ticks — so a list
         * cleared at the top of `update` throws away every cast event before anything
         * can read it. Which is exactly what it did: the visuals fired, the gameplay
         * happened, and the event log was empty. The network would have silently
         * dropped every cast message the same way.
         */
        this.events = [];

        /**
         * The impulse from the most recent blow, for the claim to carry.
         *
         * A field rather than a return value because it is filled in by `_shove` several
         * calls below where the event is built, and threading it back up would mean
         * changing four signatures to move one vector.
         */
        this.impulse = new Vector3();
    }

    /**
     * @param {number} dt
     */
    update(dt) {
        this._tickEffects(dt);
        this._resolveMelee(dt);
        this._tickVolumes(dt);
    }

    // ------------------------------------------------------------- effects
    _tickEffects(dt) {
        for (const p of this.world.players.values()) {
            p.effects.tick(dt);
            if (!p.alive) continue;
            // The DOT clock runs on every client so the number counts up smoothly on
            // all of them, but only the field's owner bills for it — otherwise four
            // clients each claim the same tick.
            const burn = p.effects.takeDotDamage(dt);
            if (burn > 0 && (this.authoritative || p.effects.source[DOT] === this.ownerId)) {
                this.damage(p, burn, p.effects.source[DOT], 0, null);
                // Reported like any other damage, so standing in a crystal field shows
                // its ticks rather than being the one source that silently drains you.
                this.events.push({
                    kind: "burn", by: p.effects.source[DOT], on: p.id, amount: burn,
                    x: p.controller.position.x,
                    y: p.controller.position.y + 1.3,
                    z: p.controller.position.z,
                });
            }
        }
    }

    // --------------------------------------------------------------- melee
    /**
     * Sweep every attacking blade against every other player.
     *
     * The swept quad — last frame's edge to this frame's — rather than the edge's
     * current position. At the peak of a strike the tip covers a metre in a frame,
     * so a static test has the blade teleport through a body; the sweep cannot.
     *
     * Parry falls out of the same pass. If the blade being tested belongs to a player
     * whose strike window is open, and the *target* is also inside their own strike
     * window, the two blades have met: nobody takes damage and both are staggered.
     * That is the whole of parry-by-clash, and it needed no new input, no new state
     * and no new animation — the recoil is the blade's existing whip spring, given
     * something to recoil from.
     */
    _resolveMelee(dt) {
        for (const attacker of this.world.players.values()) {
            const prev = this._prevBlade.get(attacker.id);
            const seg = this._bladeSegment(attacker, prev);
            if (!seg) continue;
            // The blade's history is tracked for everyone — a remote blade has to be
            // swept to be clashed *with* — but only ours resolves hits. See `ownerId`.
            if (!this._owns(attacker)) {
                this._commitBlade(attacker);
                continue;
            }
            this._sweepOne(attacker, seg);
            this._commitBlade(attacker);
        }
    }

    /**
     * One attacker's swept blade against everyone else.
     *
     * Split out so the early returns cannot skip the commit that carries the blade
     * position forward — which is exactly the shape of mistake that broke the sweep in
     * the first place.
     */
    _sweepOne(attacker, seg) {
        {
            // Only the strike phase does damage. The wind-up and the recovery move
            // the blade through people harmlessly, which is correct: a sword you are
            // drawing back is not hitting anyone.
            if (!attacker.alive || !this._striking(attacker)) return;
            const stage = attacker.combat.stage;
            if (stage <= 0) return;

            for (const target of this.world.players.values()) {
                if (target === attacker || !target.alive) continue;
                if (attacker.struckThisSwing.has(target.id)) continue;
                if (!this._segmentHitsBody(seg, target)) continue;

                if (this._striking(target)) {
                    this._clash(attacker, target);
                } else {
                    attacker.struckThisSwing.add(target.id);
                    this.damage(
                        target, SWORD_DAMAGE[stage] || 9, attacker.id,
                        SWORD_KNOCKBACK[stage] || 3, attacker.controller.position
                    );

                    // The finisher, and only the finisher, staggers. A stroke that takes a
                    // second and a half of committed animation to throw should end the
                    // exchange when it lands rather than being traded against — and the
                    // stagger is what stops the victim simply swinging back through the
                    // metre and a half the shove bought.
                    if (stage >= 3) {
                        target.effects.apply(STAGGER, 1, FINISHER_STAGGER, attacker.id);
                    }

                    // Hit-stop on *contact*, which is not the same thing as the
                    // phase-timed one the combo already applies. That one fires on
                    // every swing whether or not it connects, so it cannot be the cue
                    // that says a hit landed; this one only exists when one did, and it
                    // holds both fighters so the moment is shared rather than being
                    // something that happened to the attacker's animation.
                    attacker.controller.hitstop = Math.max(attacker.controller.hitstop, 0.07);
                    target.controller.hitstop = Math.max(target.controller.hitstop, 0.05);

                    // Where the blade met the body, near enough: the midpoint of the
                    // overlapping part of the sweep. The visual layer places its burst
                    // here, so it has to be a point on the victim rather than either
                    // fighter's origin.
                    _hitAt.copyFrom(target.controller.position);
                    _hitAt.y += 1.1;
                    _hitAt.x = (_hitAt.x + seg.tip.x) * 0.5;
                    _hitAt.y = (_hitAt.y + seg.tip.y) * 0.5;
                    _hitAt.z = (_hitAt.z + seg.tip.z) * 0.5;
                    // The amount travels with the event. The alternative — letting the
                    // HUD infer it from the stage — is a second copy of the damage table
                    // living in a file that has no business knowing it, and two copies
                    // of a balance number is one copy too many.
                    this.events.push({
                        kind: "hit", by: attacker.id, on: target.id, stage,
                        amount: SWORD_DAMAGE[stage] || 9,
                        kb: [this.impulse.x, this.impulse.y, this.impulse.z],
                        x: _hitAt.x, y: _hitAt.y, z: _hitAt.z,
                    });
                }
            }
        }
    }

    /**
     * Is this ours to resolve?
     *
     * True for everything in single player. In a networked game, true only for the local
     * player, because the other three clients are each resolving their own and a hit
     * claimed four times is a hit worth four times as much.
     *
     * @param {{ id: string }} p
     */
    _owns(p) {
        return this.ownerId === null || p.id === this.ownerId;
    }

    /** True while this player's blade is live — the strike phase, not the wind-up. */
    _striking(p) {
        const c = p.combat;
        if (c.stage <= 0) return false;
        const s = c.stageTiming;
        if (!s) return false;
        return c.t >= s.windup && c.t <= s.windup + s.strike;
    }

    /**
     * The segment the edge swept since the last frame, as four numbers in `_a`/`_b`
     * plus the previous pair. Returns null on the first frame a blade is seen, when
     * there is nothing to sweep from.
     */
    _bladeSegment(p, prev) {
        const sword = p.sword;
        if (!sword) return null;

        if (!prev) {
            // First frame this blade is seen: nothing to sweep from, so record where it
            // is and test nothing. All four vectors are allocated here, once per player,
            // and reused for the life of the fight.
            prev = {
                guard: new Vector3(), tip: new Vector3(),
                curGuard: new Vector3(), curTip: new Vector3(),
            };
            sword.bladePoint(0, prev.guard);
            sword.tipPosition(prev.tip);
            this._prevBlade.set(p.id, prev);
            return null;
        }

        sword.bladePoint(0, prev.curGuard);
        sword.tipPosition(prev.curTip);

        // The previous pair goes to the test untouched and is carried forward afterwards
        // by `_commitBlade`.
        //
        // This used to copy the current position into `prev` right here, before
        // returning — and since the returned segment held `prev.guard` by reference
        // rather than by value, `prevGuard` and `guard` were the same two vectors. Every
        // "swept" segment had zero length, so the blade was only ever tested exactly
        // where it sat on the frame boundary. At the velocity peak the tip covers about
        // 25 cm between frames, so whether a hit registered came down to where in the
        // arc the frame happened to fall: the first hit of a combo would land and the
        // next two would tunnel straight through. The sweep is the entire reason this
        // method exists, and it had been silently disabled.
        return {
            guard: prev.curGuard, tip: prev.curTip,
            prevGuard: prev.guard, prevTip: prev.tip,
        };
    }

    /**
     * Carry this frame's blade position forward, now that the tests are finished with
     * last frame's.
     *
     * Called for every player holding a blade whether or not they were striking: the
     * trail of positions has to be continuous, or the first frame of a strike would
     * sweep from wherever the blade was left standing when the previous one ended, and
     * that phantom segment can span metres.
     */
    _commitBlade(p) {
        const rec = this._prevBlade.get(p.id);
        if (!rec) return;
        rec.guard.copyFrom(rec.curGuard);
        rec.tip.copyFrom(rec.curTip);
    }

    /**
     * Does a swept blade reach a body capsule?
     *
     * Four segment-to-segment distances rather than a true swept-quad test: the
     * blade's own length, its previous position, and the two paths the guard and the
     * tip travelled. At a frame's granularity those four cover the quad closely
     * enough that no player will ever find the gap, and the exact test costs a
     * quadratic solve for a result nobody could tell apart.
     */
    _segmentHitsBody(seg, target) {
        const foot = target.controller.position;
        _a.set(foot.x, foot.y + BODY_RADIUS, foot.z);
        _b.set(foot.x, foot.y + BODY_HEIGHT - BODY_RADIUS, foot.z);
        const reach = BODY_RADIUS + BLADE_RADIUS;
        const r2 = reach * reach;
        return (
            segDist2(seg.guard, seg.tip, _a, _b) < r2 ||
            segDist2(seg.prevGuard, seg.prevTip, _a, _b) < r2 ||
            segDist2(seg.prevTip, seg.tip, _a, _b) < r2 ||
            segDist2(seg.prevGuard, seg.guard, _a, _b) < r2
        );
    }

    /**
     * Follow a player who changed id.
     *
     * Blade history and volume ownership are both keyed by player id. Leaving them under
     * the old key would give the renamed player a phantom blade segment spanning from
     * wherever they were when they joined, and orphan any volume they had already cast.
     *
     * @param {string} from @param {string} to
     */
    rekey(from, to) {
        const blade = this._prevBlade.get(from);
        if (blade) {
            this._prevBlade.delete(from);
            this._prevBlade.set(to, blade);
        }
        for (const v of this.volumes) {
            if (v.ownerId === from) v.ownerId = to;
        }
    }

    /**
     * Both blades met.
     *
     * Public because the network calls it: the client that noticed the clash reports it,
     * the authority relays, and every client runs this. Idempotent by construction — a
     * stagger takes the longer of the two timers and `interrupt` on a stopped swing does
     * nothing — so the detecting client running it twice costs nothing.
     */
    applyClash(a, b) {
        this._clash(a, b);
    }

    _clash(a, b) {
        // The clash point, for the spark: between the two blades.
        _hitAt.copyFrom(a.controller.position).addInPlace(b.controller.position).scaleInPlace(0.5);
        _hitAt.y += 1.2;
        a.effects.apply(STAGGER, 1, CLASH_STAGGER, b.id);
        b.effects.apply(STAGGER, 1, CLASH_STAGGER, a.id);
        a.combat.interrupt();
        b.combat.interrupt();
        // Push the blades apart through the spring that already models their inertia,
        // so the recoil is the same motion the swing was made of.
        a.sword.kick(6);
        b.sword.kick(6);
        a.struckThisSwing.add(b.id);
        b.struckThisSwing.add(a.id);
        this.events.push({
            kind: "clash", by: a.id, on: b.id,
            x: _hitAt.x, y: _hitAt.y, z: _hitAt.z,
        });
    }

    // --------------------------------------------------------------- spells
    /**
     * Cast a spell, as gameplay. The visual effect is a separate system's problem.
     *
     * @param {import("./player.js").Player} caster
     * @param {number} spellId 1..5
     * @param {Vector3} origin
     * @param {Vector3} aim unit
     * @param {boolean} [relayed] true when this cast has already been allowed by the
     *   authority and is being replayed from a `cast` message. The cooldown check is
     *   skipped, because it has already been made by the only party entitled to make it
     *   — and a local timer disagreeing would leave one client unable to see a spell
     *   everybody else can, which is far worse than a cooldown being a second off.
     * @returns {boolean} whether it was cast
     */
    cast(caster, spellId, origin, aim, relayed) {
        const spell = SPELLS[spellId];
        if (!spell || !caster.alive || caster.effects.locked) return false;
        if (!relayed && !caster.spellReady(spellId, this.world.now)) return false;

        caster.startCooldown(spellId, this.world.now);

        const v = this._take();
        if (!v) return true; // cast, cooldown spent, but the pool is full: no volume
        v.alive = true;
        v.spell = spell;
        v.ownerId = caster.id;
        v.age = 0;
        v.impacted.clear();
        v.dir.copyFrom(aim);

        if (spell.kind === "projectile") {
            v.pos.copyFrom(origin);
            v.vel.copyFrom(aim).scaleInPlace(spell.speed);
        } else if (spell.kind === "burst") {
            // Around the caster, and it follows them for its short life.
            v.pos.copyFrom(caster.controller.position);
            v.vel.setAll(0);
        } else {
            // Cone from the caster; sphere and field at the aim point.
            v.pos.copyFrom(origin);
            v.vel.setAll(0);
        }

        // Origin and aim travel with it, because every other client rebuilds this exact
        // volume from this message — which is what makes a spell zone authoritative
        // without the server knowing what a spell is. A relayed cast raises no event: it
        // *came* from one, and reporting it again would send it back around the loop.
        if (relayed) return true;
        this.events.push({
            kind: "cast", by: caster.id, spell: spellId,
            origin: { x: v.pos.x, y: v.pos.y, z: v.pos.z },
            aim: { x: aim.x, y: aim.y, z: aim.z },
        });
        return true;
    }

    _take() {
        for (let i = 0; i < this.volumes.length; i++) {
            if (!this.volumes[i].alive) return this.volumes[i];
        }
        return null;
    }

    _tickVolumes(dt) {
        const terrain = this.world.deps.terrain;
        for (let i = 0; i < this.volumes.length; i++) {
            const v = this.volumes[i];
            if (!v.alive) continue;
            v.age += dt;
            const spell = v.spell;

            if (spell.kind === "projectile") {
                v.vel.y -= spell.gravity * dt;
                v.pos.addInPlace(_tmp.copyFrom(v.vel).scaleInPlace(dt));
                // The ground stops it. A snowball that skips across a snowfield for
                // three seconds is a different weapon than the one specced.
                if (v.pos.y <= terrain.heightAt(v.pos.x, v.pos.z)) {
                    v.alive = false;
                    continue;
                }
            } else if (spell.kind === "burst") {
                const owner = this.world.players.get(v.ownerId);
                if (owner) v.pos.copyFrom(owner.controller.position);
            }

            const caster = this.world.players.get(v.ownerId);
            // A volume moves and draws on every client — the snowball has to fly
            // everywhere or only one player sees it — but only the caster's client
            // resolves what it touches.
            if (!this._owns({ id: v.ownerId })) continue;

            for (const target of this.world.players.values()) {
                if (!target.alive) continue;
                if (target.id === v.ownerId && !spell.selfHit) continue;
                if (!this._volumeHits(v, spell, caster, target)) continue;

                // Parry: a live blade turns away anything parryable coming at its
                // front. Recorded as impacted so a turned-away spell cannot come back
                // for a second attempt on the next frame it is still overlapping.
                if (spell.parryable && this._parries(target, v)) {
                    if (!v.impacted.has(target.id)) {
                        v.impacted.add(target.id);
                        this.events.push({ kind: "parry", by: target.id, spell: spell.id });
                    }
                    continue;
                }

                // A field's burn is refreshed every frame anyone is inside it. `apply`
                // takes the stronger magnitude and the longer timer, so refreshing is
                // idempotent and the effect simply persists while they stand there —
                // which is what makes it an area to leave rather than an event to
                // survive.
                if (spell.kind === "field" && spell.effect) {
                    target.effects.apply(
                        DOT, spell.effect.magnitude, spell.effect.seconds, v.ownerId
                    );
                }

                // Everything else happens once per target per volume.
                if (v.impacted.has(target.id)) continue;
                v.impacted.add(target.id);

                if (spell.damage > 0) {
                    this.damage(target, spell.damage, v.ownerId, spell.knockback || 0, v.pos);
                } else if (spell.knockback > 0) {
                    // A shove with no damage behind it — Vortex. Knockback used to be
                    // applied inside `damage`, which meant a zero-damage spell pushed
                    // nobody: the whole point of the spell, gated behind a hit it does
                    // not make.
                    this._shove(target, v.pos, spell.knockback);
                }
                if (spell.launch) {
                    // Vertical, and the same ownership rule as the shove: it goes out
                    // with the claim so the victim's own client throws them.
                    this.impulse.y = spell.launch;
                    if (this._ownsBody(target)) {
                        target.controller.velocityY = spell.launch;
                        target.controller.airborne = true;
                    }
                }
                if (spell.effect && spell.kind !== "field") {
                    target.effects.apply(
                        spell.effect.type, spell.effect.magnitude, spell.effect.seconds, v.ownerId
                    );
                }
                this.events.push({
                    kind: "spellHit", by: v.ownerId, on: target.id, spell: spell.id,
                    amount: spell.damage || 0,
                    // The effect rides along with the hit rather than being a second
                    // event: it is one thing that happened, and a caster's client is the
                    // only one that resolves the volume, so if this did not travel the
                    // victim would never learn it had been slowed.
                    effect: spell.effect && spell.kind !== "field" ? spell.effect.type : null,
                    magnitude: spell.effect ? spell.effect.magnitude : 0,
                    seconds: spell.effect ? spell.effect.seconds : 0,
                    kb: [this.impulse.x, this.impulse.y, this.impulse.z],
                    x: target.controller.position.x,
                    y: target.controller.position.y + 1.0,
                    z: target.controller.position.z,
                });
            }

            // Vortex sweeps projectiles out of the air.
            if (spell.deflects) this._deflect(v);

            if (v.age >= spell.life) v.alive = false;
        }
    }

    _volumeHits(v, spell, caster, target) {
        const p = target.controller.position;
        _a.set(p.x, p.y + BODY_HEIGHT * 0.5, p.z);

        if (spell.kind === "cone") {
            _d.copyFrom(_a).subtractInPlace(v.pos);
            const dist = _d.length();
            if (dist > spell.range) return false;
            if (dist < 0.001) return true;
            _d.scaleInPlace(1 / dist);
            return Math.acos(Math.max(-1, Math.min(1, Vector3.Dot(_d, v.dir)))) <= spell.halfAngle;
        }
        const r = (spell.radius || 1) + BODY_RADIUS;
        return Vector3.DistanceSquared(_a, v.pos) <= r * r;
    }

    /**
     * Does this player's live blade turn the volume away?
     *
     * A strike window and a 90-degree front. Deliberately generous on the angle and
     * deliberately strict on the window: a parry that fails because the incoming
     * thing was slightly off-centre reads as a bug, where one that fails because you
     * swung too early reads as your mistake.
     */
    _parries(target, v) {
        if (!this._striking(target)) return false;
        _d.copyFrom(v.pos).subtractInPlace(target.controller.position);
        _d.y = 0;
        if (_d.lengthSquared() < 1e-6) return true;
        _d.normalize();
        const f = target.controller.facing;
        return _d.x * Math.sin(f) + _d.z * Math.cos(f) > 0;
    }

    /** Sweep hostile projectiles out of a Vortex. */
    _deflect(burst) {
        for (let i = 0; i < this.volumes.length; i++) {
            const o = this.volumes[i];
            if (!o.alive || o === burst) continue;
            if (o.spell.kind !== "projectile") continue;
            // Snowball ignores this, as it ignores the parry.
            if (!o.spell.parryable) continue;
            if (Vector3.DistanceSquared(o.pos, burst.pos) > burst.spell.radius * burst.spell.radius) continue;
            o.alive = false;
            this.events.push({ kind: "deflect", by: burst.ownerId, spell: o.spell.id });
        }
    }

    /**
     * Push a player away from a point.
     *
     * Horizontal only: a shove that lifts people turns every knockback into a launch,
     * and launching is a specific spell's job rather than a side effect of being hit.
     *
     * @param {import("./player.js").Player} target
     * @param {Vector3} from
     * @param {number} strength m/s
     */
    /**
     * Push someone away from a blow.
     *
     * Recorded as well as applied, because in a networked game these are two different
     * questions. A victim owns its own position, so an impulse applied here to a remote
     * player would be overwritten by their very next snapshot — a visible rubber band
     * rather than a shove. So the impulse travels with the claim, the authority relays
     * it, and the victim's own client applies it to itself. `impulse` is what the claim
     * carries.
     */
    _shove(target, from, strength) {
        this.impulse.setAll(0);
        _d.copyFrom(target.controller.position).subtractInPlace(from);
        _d.y = 0;
        if (_d.lengthSquared() < 1e-6) return;
        _d.normalize().scaleInPlace(strength);
        this.impulse.set(_d.x, 0, _d.z);
        if (this._ownsBody(target)) {
            target.controller.velocity.x += _d.x;
            target.controller.velocity.z += _d.z;
        }
    }

    /**
     * Is this player's *position* ours to change?
     *
     * Distinct from `_owns`, which asks whose hits we resolve. Under the trusted-client
     * model each client owns where its own player is and nowhere else, so a knockback,
     * a launch or a respawn position may only be written for ourselves — everyone else
     * gets told and does it themselves.
     */
    _ownsBody(target) {
        return this.ownerId === null || target.id === this.ownerId;
    }

    /**
     * Apply an impulse that arrived from the authority.
     *
     * @param {import("./player.js").Player} target
     * @param {number} x @param {number} y @param {number} z
     */
    applyImpulse(target, x, y, z) {
        if (!target.alive) return;
        target.controller.velocity.x += x;
        target.controller.velocity.z += z;
        if (y > 0) {
            target.controller.velocityY = y;
            target.controller.airborne = true;
        }
    }

    // --------------------------------------------------------------- damage
    /**
     * Apply damage, knockback and death.
     *
     * The single write path for health, so "who is dead" has one answer. When the
     * network lands this is the method the authority calls and nobody else does.
     *
     * @param {import("./player.js").Player} target
     * @param {number} amount
     * @param {string|null} byId
     * @param {number} knockback m/s
     * @param {Vector3|null} from where the blow came from, for the shove direction
     */
    damage(target, amount, byId, knockback, from) {
        if (!target.alive) return;

        // The shove, the flash and the hit-stop are *feel*, and they happen on whichever
        // client noticed the hit, immediately. Waiting for the server to confirm a hit
        // before the victim reacts to it would put the whole latency of the round trip
        // between the blade landing and anything happening, which is the one place in a
        // fight where a delay is unmistakable.
        target.flash = 1;
        if (knockback > 0 && from) this._shove(target, from, knockback);

        if (!this.authoritative) {
            // Someone else owns health. The claim goes out in `events`, the server
            // arbitrates, and the number arrives back as a `health` message.
            //
            // Not deducting locally is deliberate, and it is the difference between a
            // health bar that is occasionally wrong and one that is never wrong: four
            // clients each subtracting their own guess would drift apart within a single
            // exchange, and two of them can each believe they landed the killing blow.
            return;
        }

        target.health -= amount;
        if (target.health <= 0) this.kill(target, byId);
    }

    /**
     * Put someone down.
     *
     * Split out of `damage` because the authority reaches it by a different road: it
     * arrives at a health of zero over a socket, having done the arithmetic itself, and
     * still needs the local consequences — the swing interrupted, the effects cleared,
     * the death event raised for the kill feed.
     *
     * @param {import("./player.js").Player} target
     * @param {string|null} byId
     */
    kill(target, byId) {
        if (!target.alive) return;
        target.health = 0;
        target.alive = false;
        target.respawnAt = this.world.now + RESPAWN_TIME;
        target.combat.interrupt();
        target.effects.clearAll();
        target.deaths++;
        // Only when the authority is local. Networked, the score comes down with the
        // death message, because a self-inflicted death pays nobody and only the server
        // sees enough to make that call consistently.
        if (this.authoritative && byId && byId !== target.id) {
            const killer = this.world.players.get(byId);
            if (killer) killer.kills++;
        }
        this.events.push({ kind: "death", on: target.id, by: byId });
    }
}

/**
 * Squared distance between two segments.
 *
 * The standard clamped-parameter solve. Written out rather than pulled from a
 * library because it is the inner loop of every melee test in the game and because
 * the degenerate cases — a zero-length blade on the first frame, two parallel
 * segments — have to be handled rather than producing a NaN that silently makes
 * every hit land.
 */
function segDist2(p1, q1, p2, q2) {
    const d1x = q1.x - p1.x, d1y = q1.y - p1.y, d1z = q1.z - p1.z;
    const d2x = q2.x - p2.x, d2y = q2.y - p2.y, d2z = q2.z - p2.z;
    const rx = p1.x - p2.x, ry = p1.y - p2.y, rz = p1.z - p2.z;

    const a = d1x * d1x + d1y * d1y + d1z * d1z;
    const e = d2x * d2x + d2y * d2y + d2z * d2z;
    const f = d2x * rx + d2y * ry + d2z * rz;

    let s;
    let t;
    if (a <= 1e-8 && e <= 1e-8) {
        return rx * rx + ry * ry + rz * rz;
    }
    if (a <= 1e-8) {
        s = 0;
        t = Math.max(0, Math.min(1, f / e));
    } else {
        const c = d1x * rx + d1y * ry + d1z * rz;
        if (e <= 1e-8) {
            t = 0;
            s = Math.max(0, Math.min(1, -c / a));
        } else {
            const b = d1x * d2x + d1y * d2y + d1z * d2z;
            const denom = a * e - b * b;
            s = denom > 1e-8 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
            t = (b * s + f) / e;
            if (t < 0) {
                t = 0;
                s = Math.max(0, Math.min(1, -c / a));
            } else if (t > 1) {
                t = 1;
                s = Math.max(0, Math.min(1, (b - c) / a));
            }
        }
    }

    const cx = p1.x + d1x * s - (p2.x + d2x * t);
    const cy = p1.y + d1y * s - (p2.y + d2y * t);
    const cz = p1.z + d1z * s - (p2.z + d2z * t);
    return cx * cx + cy * cy + cz * cz;
}
