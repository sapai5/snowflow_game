/**
 * One character in the world: local, scripted, or (later) remote.
 *
 * Everything that used to be a singleton in `main.js` — the controller, the figure,
 * the sword, the combo, the snow contact — is owned per player here. That is the
 * whole point of the type: the game had exactly one of each, and every system that
 * assumed so had to be found and unpicked before four of anything was possible.
 *
 * A player does not know how it is being driven. `intent` is handed in from
 * outside: the local player gets the real input singleton, a scripted one gets a
 * written intent, and a networked one will get an intent rebuilt from a snapshot.
 * The simulation below is identical in all three cases, which is what keeps a
 * remote character's animation *correct* rather than approximated — it runs the same
 * gait, the same cloth and the same sword springs the local one does.
 *
 * Detail levels exist because the expensive part of a character is its cloth solve,
 * and four of those is a real cost while four *silhouettes* is not. See `setLod`.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { CharacterController } from "../character/controller.js";
import { Character } from "../character/character.js";
import { IceSword } from "../character/sword.js";
import { SwordCombat } from "../character/swordCombat.js";
import { SwordTrail } from "../vfx/swordTrail.js";
import { SlashArc } from "../vfx/slashArc.js";
import { SnowContact } from "../character/snowContact.js";
import { IDLE_INTENT, makeIntent } from "./intent.js";
import { MAX_HEALTH } from "./rules.js";
import { Effects } from "./effects.js";
import { SPELL_COOLDOWN } from "./combat.js";

/** Detail tiers. Distances are metres from the camera. */
export const LOD_FULL = 0;
export const LOD_MID = 1;
export const LOD_FAR = 2;

const LOD_MID_RANGE = 10;
const LOD_FAR_RANGE = 30;

let nextLocalId = 1;

export class Player {
    /**
     * @param {object} deps scene, terrain, sky, shadows, spray, deform
     * @param {{ id?: string, name?: string, isLocal?: boolean }} [opts]
     */
    constructor(deps, opts = {}) {
        this.id = opts.id || "p" + nextLocalId++;
        this.name = opts.name || this.id;
        this.isLocal = !!opts.isLocal;

        this.controller = new CharacterController(deps.terrain);
        this.figure = new Character(deps.scene, deps.terrain, deps.sky, deps.shadows, this.controller);
        this.sword = new IceSword(deps.scene, deps.sky, deps.shadows, this.figure.figure);
        this.combat = new SwordCombat(this.controller);
        // A seed per player, so four trails do not carry identical gold banding.
        this.trail = new SwordTrail(deps.scene, Math.random() * 6.283);
        // The sheet. Takes the spray pool because the arc throws powder off its outer
        // rim — the one part of that effect which is not stylisation, since the point is
        // moving through a snowfield at ten metres a second.
        this.slash = new SlashArc(deps.scene, deps.spray);
        // One contact per player rather than one shared: it carries per-character
        // state — the last blade tip, the distance since the last scuff — and
        // sharing it would have four characters overwriting each other's history.
        this.contact = new SnowContact(
            this.controller, deps.deform, this.figure.figure, deps.spray, this.sword
        );

        /** What this player is being told to do. Replaced each frame by its driver. */
        this.intent = IDLE_INTENT;
        this.lod = LOD_FULL;

        // ------------------------------------------------------------- combat
        //
        // Owned by the server once there is one, and by whoever is simulating until
        // then. The fields are deliberately plain numbers: they are what a snapshot
        // carries, and a snapshot of an object graph is a serialiser nobody needs.
        this.health = MAX_HEALTH;
        this.maxHealth = MAX_HEALTH;

        // Kept locally so the scoreboard works offline against the dummies too. In a
        // networked game the authority's numbers replace these, because two clients can
        // each believe they landed the same kill.
        this.kills = 0;
        this.deaths = 0;
        this.alive = true;
        this.respawnAt = 0;
        /** 0..1, decays. Drives the HUD's damage vignette and a hit flash. */
        this.flash = 0;
        this.effects = new Effects();
        /**
         * When each spell next becomes castable, on the world clock. Zero is ready,
         * which is also the correct state for a player who has just joined.
         */
        this.cooldowns = new Float32Array(5);
        /**
         * Who this swing has already struck. Cleared when a new attack starts, so one
         * swing cannot hit the same player twice as the blade sweeps back through
         * them — which the swept-segment test would otherwise happily do.
         */
        this.struckThisSwing = new Set();
        this._lastStage = 0;

        /**
         * Driven by the network rather than by input.
         *
         * Set by the net client for everyone who is not us. A remote player is a full
         * `Player` — same controller, figure, sword, combo and contact — differing only
         * in where its position comes from, which is the whole reason the intent seam
         * was built before any of the networking was.
         */
        this.remote = false;
        /** Newest combo stage reported by their client. */
        this.netStage = 0;
        /** Newest aim yaw reported by their client. */
        this.netAimYaw = 0;
        /** Reusable intent for the remote path; per-frame allocation is not allowed. */
        this._ni = makeIntent();

        this._pos = new Vector3();
    }

    /** @param {number} spellId 1..5 @param {number} now */
    spellReady(spellId, now) {
        return this.cooldowns[spellId - 1] <= now;
    }

    /** @param {number} spellId 1..5 @param {number} now */
    startCooldown(spellId, now) {
        this.cooldowns[spellId - 1] = now + SPELL_COOLDOWN;
    }

    /**
     * Back on your feet.
     *
     * Cooldowns are cleared as well as health: dying already costs four seconds and
     * a position, and losing a 45-second spell on top of that punishes one mistake
     * twice.
     *
     * @param {Vector3} pos @param {number} facing
     */
    respawn(pos, facing = 0) {
        this.trail.clear();
        this.health = this.maxHealth;
        this.alive = true;
        this.flash = 0;
        this.effects.clearAll();
        this.cooldowns.fill(0);
        this.combat.interrupt();
        this.placeAt(pos, facing);
    }

    /** @param {Vector3} pos @param {number} facing */
    placeAt(pos, facing = 0) {
        this.controller.position.copyFrom(pos);
        this.controller.position.y = this.controller.terrain.heightAt(pos.x, pos.z);
        this.controller.facing = facing;
        this.controller.velocity.setAll(0);
    }

    /**
     * Choose a detail level from distance.
     *
     * Only the cloth and the fur are dropped, never the skeleton: a character's
     * silhouette and its gait are what read at range, and they are also the cheap
     * part. The robe is what costs — 1728 Verlet particles at six iterations — and
     * beyond ten metres nobody can tell it from a skirt that merely follows the
     * hips, which is exactly what `LOD_MID` and `LOD_FAR` give them.
     *
     * @param {Vector3} cameraPos
     */
    updateLod(cameraPos) {
        if (this.isLocal) {
            this.lod = LOD_FULL;
        } else {
            const d = Vector3.Distance(this.controller.position, cameraPos);
            this.lod = d < LOD_MID_RANGE ? LOD_FULL : d < LOD_FAR_RANGE ? LOD_MID : LOD_FAR;
        }
        this.figure.setLod(this.lod);
    }

    /**
     * Advance one player.
     *
     * The order inside is the order the single-player path used and it still
     * matters: locomotion, then the combo (which writes the pose state the figure
     * reads), then the figure, then the sword (which hangs off the posed hand),
     * then the contact pass (which reads the *posed* foot and blade rather than the
     * controller's estimate of them).
     *
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     */
    update(dt, rig) {
        let intent = this.intent;
        // A staggered or dead player is not taking instructions. Substituting an idle
        // intent rather than skipping the update is what keeps them animating — they
        // still stand, still settle, still have cloth — and it means every consumer
        // downstream sees a player who simply chose to do nothing.
        if (!this.alive || this.effects.locked) intent = IDLE_INTENT;

        // A new swing forgets who the last one hit.
        if (this.combat.stage !== this._lastStage) {
            if (this.combat.stage > 0) this.struckThisSwing.clear();
            this._lastStage = this.combat.stage;
        }

        this.flash = this.flash > 0 ? Math.max(0, this.flash - dt * 2.2) : 0;
        this.controller.moveScale = this.effects.moveScale;

        if (this.remote) {
            // Position came off the wire before this ran. The controller derives the rest
            // — ground, blends, lean, gait — without integrating anything.
            intent = this._netIntent(intent);
            this.controller.applyNetwork(dt, rig, intent);
        } else {
            this.controller.update(dt, rig, intent);
        }
        this.combat.update(dt, rig, intent);
        this.figure.update(dt);
        this.sword.update(dt, this.controller);
        this.sword.feedCloth(this.figure.solver);
        // Only a live strike leaves light. Carrying the thing around does not, and the
        // wind-up does not either — the blade is travelling backward slowly and a
        // ribbon there reads as the sword leaking rather than as a swing.
        const bladeLive = this.combat.stage > 0 && this._bladeLive();
        this.trail.update(dt, this.sword, bladeLive);
        // The broad sheet, from the same window. Two effects rather than one: the contrail
        // says where the edge went, the sheet says how much the swing covered.
        this.slash.update(dt, this.sword, bladeLive);
        this.contact.update(dt);
    }

    /**
     * Turn a remote player's reported state into an intent.
     *
     * Their combo runs on this client's own state machine, triggered by the stage number
     * in the snapshot rather than by having `stage` written into it directly. That keeps
     * the swing's springs continuous — an arc whose clock jumps every 50 ms stutters —
     * at the cost of starting up to one snapshot late, which is well inside the window
     * that decides a clash.
     *
     * The press fires whenever the wire is *ahead* of the local machine, which covers
     * the whole chain: 0 to 1 starts a string, and 1 to 2 to 3 continues one. A new
     * string after a finisher arrives as 3 back to 1, which the local machine has
     * already dropped to 0 by the time it is seen, so it reads as a fresh start.
     *
     * @param {ReturnType<typeof import("./intent.js").makeIntent>} base
     */
    _netIntent(base) {
        const it = this._ni;
        it.moveX = 0;
        it.moveZ = 0;
        it.sprint = false;
        it.surf = this.controller.surfActive;
        it.jump = false;
        it.jumpPressed = false;
        it.attackPressed = this.netStage > 0 && this.netStage > this.combat.stage;
        it.spellPressed = 0;
        it.spellHeld2 = false;
        // Facing is authoritative from the wire, so nothing here steers; aim is what the
        // sword's wind-up snap reads.
        it.faceYaw = this.controller.facing;
        it.aimYaw = this.netAimYaw;
        // A dead or staggered remote gets the idle intent for the same reason a local one
        // does, and `base` is already that when it applies.
        return base === IDLE_INTENT ? base : it;
    }

    /**
     * True while the blade is in its strike phase.
     *
     * The same window the hit resolver uses to decide the blade is dangerous, asked the
     * same way, so what leaves a trail and what can hurt you are the same thing.
     */
    _bladeLive() {
        const s = this.combat.stageTiming;
        if (!s) return false;
        const t = this.combat.t;
        return t >= s.windup && t <= s.windup + s.strike;
    }

    /** @param {Vector3} cameraPos */
    sync(cameraPos) {
        this.figure.sync(cameraPos);
        this.sword.sync(cameraPos);
        this.trail.sync(cameraPos);
    }

    get triangles() {
        return this.figure.triangles
            + (this.sword.mesh.isVisible ? this.sword.triangles : 0)
            + this.slash.triangles;
    }

    setVisible(v) {
        this.figure.setVisible(v);
        this.sword.setVisible(v);
    }

    dispose() {
        this.trail.dispose();
        this.slash.dispose();
        this.sword.dispose();
        this.figure.dispose();
    }
}
