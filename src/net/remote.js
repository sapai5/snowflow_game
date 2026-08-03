/**
 * Remote players, from snapshots.
 *
 * A remote player is not simulated. Its client already decided where it is and said so;
 * re-running the physics here would produce a second, slightly different answer that
 * then has to be corrected back — which is exactly the prediction-and-reconciliation
 * machinery the trusted-client decision removed. So positions come off the wire and are
 * written straight onto the controller.
 *
 * What is *not* on the wire is everything derived: ground height, lean, the gait phase,
 * the surf blend, spray, footprints. Those are computed locally from the interpolated
 * position, which is why a remote player has legs that move correctly rather than a
 * figure sliding along the snow in a T-pose.
 *
 * Two snapshots are held either side of a render time deliberately kept ~100 ms behind
 * the newest one. Interpolating between two known positions is the only way to get
 * smooth motion out of a 20 Hz feed; extrapolating forward from the newest one instead
 * would be 100 ms more responsive and wrong in every direction the moment somebody
 * turns, and a remote player who overshoots corners is worse to fight than one who is
 * a tenth of a second behind.
 */

import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { INTERP_DELAY, stateFlags } from "./protocol.js";

/** Snapshots kept per player. At 20 Hz this is 1.5 s, far more than the delay needs. */
const HISTORY = 30;

const _from = new Vector3();
const _to = new Vector3();

/** Shortest signed angle from a to b. Angles on the wire wrap; lerping them does not. */
function angleLerp(a, b, k) {
    let d = b - a;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    return a + d * k;
}

/**
 * One remote player's history.
 */
class Track {
    constructor() {
        /** @type {Array<{ at: number, s: object }>} */
        this.frames = [];
        this.lastAt = -1;
    }

    /** @param {number} at server time @param {object} s */
    push(at, s) {
        // Out-of-order or duplicate frames are dropped rather than sorted in. UDP-style
        // reordering cannot happen on a WebSocket, so a frame arriving late means a
        // clock that jumped, and inserting it would make the interpolation walk
        // backwards.
        if (at <= this.lastAt) return;
        this.lastAt = at;
        this.frames.push({ at, s });
        if (this.frames.length > HISTORY) this.frames.shift();
    }

    /**
     * The pair of frames bracketing `t`, and how far between them it is.
     *
     * Returns null when there is nothing usable yet. Past the end of the history it
     * clamps to the newest frame rather than extrapolating — a player whose client has
     * stopped talking should stand still, not keep gliding into the distance.
     */
    at(t) {
        const f = this.frames;
        if (f.length === 0) return null;
        if (f.length === 1 || t <= f[0].at) return { a: f[0].s, b: f[0].s, k: 0 };
        for (let i = f.length - 1; i > 0; i--) {
            if (t >= f[i - 1].at) {
                if (t >= f[i].at) return { a: f[i].s, b: f[i].s, k: 0 };
                const span = f[i].at - f[i - 1].at;
                return {
                    a: f[i - 1].s, b: f[i].s,
                    k: span > 1e-6 ? (t - f[i - 1].at) / span : 0,
                };
            }
        }
        return { a: f[0].s, b: f[0].s, k: 0 };
    }
}

/**
 * Holds every remote player's snapshot history and applies it.
 */
export class RemoteDriver {
    constructor() {
        /** @type {Map<string, Track>} */
        this.tracks = new Map();

        /**
         * Server time minus local time.
         *
         * Estimated from the newest snapshot rather than from a ping exchange: the
         * render clock is already 100 ms behind, so an offset that is a few tens of
         * milliseconds off changes nothing that can be seen. Tracked as a *minimum*
         * over recent frames because the largest source of error here is a snapshot that
         * sat in a buffer, and that only ever makes the offset look later than it is.
         */
        this.offset = null;
        this._offsetFloor = Infinity;
        this._sinceOffset = 0;
    }

    /**
     * Seed the clock from the welcome.
     *
     * Without this the offset is not known until the first snapshot arrives, and every
     * server timestamp received before then converts with an offset of zero — which is
     * not a small error, it is the server's entire uptime. A three second slow arrived as
     * however long the relay had been running, and a 45 second cooldown looked like it
     * would never come back. The welcome carries the server clock precisely so that the
     * very first ruling can be converted correctly.
     *
     * @param {number} serverNow
     * @param {number} localNow
     */
    seedClock(serverNow, localNow) {
        if (typeof serverNow !== "number" || !Number.isFinite(serverNow)) return;
        this.offset = serverNow - localNow;
        // Also the floor, so the first second of settling does not drag the estimate
        // toward a stale value.
        this._offsetFloor = this.offset;
    }

    /** @param {number} at server time on the snapshot @param {object} states by id */
    accept(at, states, localTime) {
        const seen = at - localTime;
        if (this.offset === null) this.offset = seen;
        this._offsetFloor = Math.min(this._offsetFloor, seen);

        for (const id in states) {
            let track = this.tracks.get(id);
            if (!track) {
                track = new Track();
                this.tracks.set(id, track);
            }
            track.push(at, states[id]);
        }
    }

    /** Forget a player who left, so a rejoin does not inherit their old history. */
    forget(id) {
        this.tracks.delete(id);
    }

    /**
     * Advance the clock estimate.
     *
     * The floor is adopted in steps rather than jumped to, because the offset feeds
     * directly into which pair of snapshots gets interpolated and a discontinuity there
     * is a visible hitch in every remote player at once.
     */
    tick(dt) {
        this._sinceOffset += dt;
        if (this._sinceOffset >= 1 && this._offsetFloor !== Infinity) {
            this._sinceOffset = 0;
            if (this.offset === null) this.offset = this._offsetFloor;
            else this.offset += (this._offsetFloor - this.offset) * 0.25;
            this._offsetFloor = Infinity;
        }
    }

    /** The server time to draw remotes at, given the local clock. */
    renderTime(localTime) {
        return localTime + (this.offset === null ? 0 : this.offset) - INTERP_DELAY;
    }

    /**
     * Write the interpolated state onto a player.
     *
     * @param {import("../game/player.js").Player} p
     * @param {number} localTime
     * @returns {boolean} false if there is nothing to apply yet
     */
    apply(p, localTime) {
        const track = this.tracks.get(p.id);
        if (!track) return false;
        const pair = track.at(this.renderTime(localTime));
        if (!pair) return false;

        const { a, b, k } = pair;
        _from.set(a.x, a.y, a.z);
        _to.set(b.x, b.y, b.z);
        Vector3.LerpToRef(_from, _to, k, p.controller.position);

        const c = p.controller;
        c.velocity.set(
            a.vx + (b.vx - a.vx) * k,
            a.vy + (b.vy - a.vy) * k,
            a.vz + (b.vz - a.vz) * k
        );
        c.facing = angleLerp(a.f, b.f, k);

        const flags = stateFlags(b);
        c.surfActive = flags.surf;
        c.airborne = flags.air;

        // The swing arrives as a stage number, and it is deliberately *not* written
        // onto the combat state machine.
        //
        // Forcing `stage` and `t` from the wire would give the two clients an exactly
        // matching strike window, which sounds like the better answer for hit detection.
        // It is not, because the pose is not a function of `t` alone: the arc, the lag
        // chain and the blade's whip are springs carrying state between frames, and a
        // clock that jumps 50 ms every snapshot makes them stutter. `stageTiming` is a
        // getter over `stage` besides, so it cannot be assigned at all.
        //
        // Instead the stage is recorded and the remote's own state machine is triggered
        // by it — see `Player._netIntent`. The swing then runs locally and smoothly, one
        // snapshot behind the truth, which is well inside the window that matters for a
        // clash.
        p.netStage = b.st;
        // Their aim, so a remote blade sweeps where its owner pointed it rather than
        // where this client's camera happens to look.
        p.netAimYaw = angleLerp(a.a, b.a, k);
        return true;
    }
}
