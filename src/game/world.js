/**
 * The player table.
 *
 * `main.js` used to own one character and call six systems on it in a fixed order.
 * That order was correct and is preserved exactly — locomotion, combo, figure,
 * sword, contact — but it now runs per player, and *who* the players are is data
 * rather than structure. Adding a fourth is a `spawn()` call; adding the network is
 * a driver that writes intents.
 *
 * The world owns nothing about rendering. It holds players, decides their detail
 * tiers, and sequences their updates. Everything visual already belongs to the
 * systems the players own.
 *
 * Allocation per frame: none.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { Player } from "./player.js";
import { CombatResolver } from "./combat.js";
import { mark } from "../core/perf.js";

/** Spawn ring radius, metres — inside the combat area, clear of the centre. */
const SPAWN_RADIUS = 18;

export class World {
    /**
     * @param {object} deps scene, terrain, sky, shadows, spray, deform
     */
    constructor(deps) {
        this.deps = deps;
        /** @type {Map<string, Player>} */
        this.players = new Map();
        /** @type {Player|null} */
        this.local = null;
        this._spawnIndex = 0;
        this._spawn = new Vector3();

        /**
         * The game clock, seconds since the world started.
         *
         * Its own clock rather than `performance.now()` because cooldowns, respawn
         * timers and (soon) the network all have to agree on what time it is, and a
         * clock that pauses when the tab does is the only one that behaves when a
         * player alt-tabs mid-fight.
         */
        this.now = 0;

        this.combat = new CombatResolver(this);
    }

    /**
     * Add a player.
     *
     * @param {{ id?: string, name?: string, isLocal?: boolean }} [opts]
     * @returns {Player}
     */
    spawn(opts = {}) {
        const p = new Player(this.deps, opts);
        this.players.set(p.id, p);
        if (p.isLocal) this.local = p;

        // Around a ring, so four players start apart but within sight of each other
        // rather than scattered across a square kilometre.
        // Soft aim tracking during wind-ups needs to know who is nearby, and the combo
        // deliberately has no access to the player table — so the world hands it a
        // closure. Remote players are excluded at call time rather than at spawn time,
        // because the remote flag is set after spawn: their facing comes off the wire,
        // and a locally-tracked goal would fight it every frame.
        p.combat.findTarget = () => (p.remote ? null : this._nearestFoe(p));

        const i = this._spawnIndex++;
        const theta = (i / 4) * Math.PI * 2;
        this._spawn.set(Math.cos(theta) * SPAWN_RADIUS, 0, Math.sin(theta) * SPAWN_RADIUS);
        // Facing the middle, which is where the other three are.
        p.placeAt(this._spawn, theta + Math.PI);
        return p;
    }

    /** @param {string} id */
    despawn(id) {
        const p = this.players.get(id);
        if (!p) return;
        if (this.local === p) this.local = null;
        p.dispose();
        this.players.delete(id);
    }

    /**
     * Advance every player.
     *
     * The local player goes first, deliberately: the camera follows it, and the
     * others are drawn relative to a camera that has already been given this
     * frame's truth rather than last frame's.
     *
     * @param {number} dt
     * @param {import("../core/camera.js").CameraRig} rig
     * @param {Vector3} cameraPos
     */
    update(dt, rig, cameraPos) {
        const t0 = performance.now();
        this.now += dt;

        if (this.local) {
            this.local.updateLod(cameraPos);
            this.local.update(dt, rig);
            this.deps.terrain.heightfield.clampToPlayArea(this.local.controller.position);
        }
        let others = 0;
        for (const p of this.players.values()) {
            if (p === this.local) continue;
            p.updateLod(cameraPos);
            p.update(dt, rig);
            // Everyone is held inside the combat area, not just whoever is holding
            // the keyboard.
            this.deps.terrain.heightfield.clampToPlayArea(p.controller.position);
            others++;
        }

        // Combat after movement, so a hit is tested against where everyone actually
        // ended up this frame rather than against last frame's positions — which at a
        // closing speed of two sprinting players is most of a metre of error.
        const tSim = performance.now();
        this.combat.update(dt);
        this._respawns();
        mark("cpu combat", performance.now() - tSim);

        const ms = performance.now() - t0;
        mark("cpu players", ms);
        if (others > 0) mark("cpu remote", (ms * others) / (others + 1));
    }

    /**
     * Put the dead back, once their four seconds are up.
     *
     * Spawned as far from the living as the ring allows rather than at a fixed point:
     * respawning inside someone's swing is the one death a player will not forgive,
     * and with four players on a ring the furthest vacant arc is always good enough.
     */
    _respawns() {
        for (const p of this.players.values()) {
            if (p.alive || this.now < p.respawnAt) continue;
            // Only the authority decides when someone is back, and only their own client
            // decides where. In a networked game this loop runs for nobody: the local
            // player is respawned by a `spawned` message and the others by their
            // snapshots.
            if (!this.combat.authoritative) continue;
            let best = 0;
            let bestDist = -1;
            for (let i = 0; i < 8; i++) {
                const theta = (i / 8) * Math.PI * 2;
                this._spawn.set(Math.cos(theta) * SPAWN_RADIUS, 0, Math.sin(theta) * SPAWN_RADIUS);
                let nearest = Infinity;
                for (const q of this.players.values()) {
                    if (q === p || !q.alive) continue;
                    nearest = Math.min(nearest, Vector3.DistanceSquared(this._spawn, q.controller.position));
                }
                if (nearest > bestDist) {
                    bestDist = nearest;
                    best = theta;
                }
            }
            this._spawn.set(Math.cos(best) * SPAWN_RADIUS, 0, Math.sin(best) * SPAWN_RADIUS);
            p.respawn(this._spawn, best + Math.PI);
        }
    }

    /**
     * The nearest living opponent, for the combo's soft tracking.
     *
     * Bare nearest-by-distance: the cone and range tests live in the combo, next to the
     * constants that define them, so this stays a lookup rather than half of a policy
     * split across two files.
     *
     * @param {Player} self
     * @returns {Player|null}
     */
    _nearestFoe(self) {
        let best = null;
        let bestD2 = Infinity;
        for (const q of this.players.values()) {
            if (q === self || !q.alive) continue;
            const d2 = Vector3.DistanceSquared(
                self.controller.position, q.controller.position
            );
            if (d2 < bestD2) {
                bestD2 = d2;
                best = q;
            }
        }
        return best;
    }

    /**
     * Put the local player back where the ring says, now rather than on a timer.
     *
     * Called when the authority says we have respawned. The spawn choice is the same
     * "furthest from anyone living" search the offline path uses — a client picking its
     * own spot is fine, because a client already owns where it is, and it is the only
     * one that can be sure it will not land inside somebody's swing.
     *
     * @param {Player} p
     */
    respawnLocal(p) {
        let best = 0;
        let bestDist = -1;
        for (let i = 0; i < 8; i++) {
            const theta = (i / 8) * Math.PI * 2;
            this._spawn.set(Math.cos(theta) * SPAWN_RADIUS, 0, Math.sin(theta) * SPAWN_RADIUS);
            let nearest = Infinity;
            for (const q of this.players.values()) {
                if (q === p || !q.alive) continue;
                nearest = Math.min(
                    nearest,
                    Vector3.DistanceSquared(this._spawn, q.controller.position)
                );
            }
            if (nearest > bestDist) {
                bestDist = nearest;
                best = theta;
            }
        }
        this._spawn.set(Math.cos(best) * SPAWN_RADIUS, 0, Math.sin(best) * SPAWN_RADIUS);
        p.respawn(this._spawn, best + Math.PI);
    }

    /**
     * Change a player's id.
     *
     * The local player exists before the socket does — the game is playable offline and
     * joining should not restart it — so when the authority hands out an id, the player
     * already in the table adopts it. Keyed by id rather than by index for exactly this.
     *
     * @param {Player} p
     * @param {string} id
     */
    rekey(p, id) {
        if (p.id === id) return;
        this.players.delete(p.id);
        // The resolver keeps blade history and volume ownership under the old key; both
        // are keyed by id and both would leak. History is cheap to rebuild — one frame
        // with no sweep — and volumes belong to a caster who is about to be renamed.
        this.combat.rekey(p.id, id);
        p.id = id;
        this.players.set(id, p);
    }

    /** @param {Vector3} cameraPos */
    sync(cameraPos) {
        for (const p of this.players.values()) p.sync(cameraPos);
    }

    /**
     * Close the frame.
     *
     * Combat events live until here, after every consumer — the HUD, and soon the
     * network — has had a chance to read them. Clearing them where they are produced
     * would drop everything raised before the resolver ran, and casting is raised
     * before the resolver runs.
     */
    endFrame() {
        this.combat.events.length = 0;
    }

    get triangles() {
        let n = 0;
        for (const p of this.players.values()) n += p.triangles;
        return n;
    }

    get count() {
        return this.players.size;
    }
}
