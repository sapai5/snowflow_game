/**
 * Shared fakes.
 *
 * A `Player` in the real game owns a figure, a garment solver and a sword mesh, none
 * of which exist without a GPU. These stand-ins carry exactly the fields the
 * simulation reads and nothing else, which is also a useful check in itself: when a
 * test needs a new field here, the simulation has grown a new dependency on rendering
 * and that is worth noticing.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Effects } from "../src/game/effects.js";
import { SPELL_COOLDOWN } from "../src/game/combat.js";

export const terrain = { heightAt: () => 0, normalAt: (x, z, o) => o.set(0, 1, 0) };

export const rig = {
    yaw: 0,
    trauma: 0,
    addTrauma(a) { this.trauma += a; },
    getFlatForward: (o) => o.set(0, 0, 1),
    getFlatRight: (o) => o.set(1, 0, 0),
    camera: { position: new Vector3(0, 1.6, -4) },
};

/** One stage table, matching the real jab closely enough for timing tests. */
export const STAGE = { windup: 0.12, strike: 0.19, recover: 0.15 };

export function mkPlayer(id, x = 0, z = 0) {
    return {
        id, name: id, isLocal: false,
        alive: true, health: 100, maxHealth: 100, flash: 0, respawnAt: 0,
        effects: new Effects(),
        cooldowns: new Float32Array(5),
        struckThisSwing: new Set(),
        intent: null,
        controller: {
            position: new Vector3(x, 0, z), velocity: new Vector3(), facing: 0,
            velocityY: 0, airborne: false, moveScale: 1,
            // Hit-stop lives on the controller because the phase clock, the pose
            // springs and the blade's whip all have to slow by the same factor.
            hitstop: 0,
            update() {},
        },
        combat: {
            stage: 0, t: 0, stageTiming: null,
            interrupt() { this.stage = 0; this.t = 0; },
            update() {},
        },
        sword: {
            _g: new Vector3(x, 1, z), _t: new Vector3(x, 1, z), kicked: false,
            bladePoint(t, o) { o.copyFrom(this._g); return o; },
            tipPosition(o) { o.copyFrom(this._t); return o; },
            kick() { this.kicked = true; },
            update() {}, feedCloth() {},
        },
        figure: { update() {}, sync() {}, solver: {}, setLod() {}, triangles: 0 },
        contact: { update() {} },
        spellReady(i, now) { return this.cooldowns[i - 1] <= now; },
        startCooldown(i, now) { this.cooldowns[i - 1] = now + SPELL_COOLDOWN; },
        updateLod() {}, sync() {}, update() {},
    };
}

export function mkWorld(players) {
    const map = new Map();
    for (const p of players) map.set(p.id, p);
    return { players: map, local: players[0], now: 0, deps: { terrain } };
}

/** Put a player's blade a metre in front of them, along their facing. */
export function aimBlade(p, atX, atZ) {
    const c = p.controller;
    p.sword._g.set(c.position.x, c.position.y + 1.1, c.position.z);
    p.sword._t.set(atX, c.position.y + 1.1, atZ);
}

export function suite() {
    const messages = [];
    let total = 0;
    let failed = 0;
    return {
        ok(cond, msg) {
            total++;
            if (!cond) { failed++; messages.push("FAIL: " + msg); }
        },
        result() { return { total, failed, messages }; },
    };
}
