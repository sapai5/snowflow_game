/**
 * Snapshot interpolation.
 *
 * The part of the netcode with no server to blame: given a 20 Hz feed of positions, it
 * has to produce a smooth one at whatever the frame rate is. Everything here is arithmetic
 * on plain numbers, so it is all testable, and worth testing because every failure mode
 * looks the same in the game — a remote player who is subtly wrong.
 */
import { RemoteDriver } from "../src/net/remote.js";
import { INTERP_DELAY, encodeState, stateFlags, F_SURF, F_AIR, F_DEAD } from "../src/net/protocol.js";
import { suite, mkPlayer } from "./harness.mjs";

/** A state as the wire carries it. */
function st(x, z, f = 0, extra = {}) {
    return { x, y: 0, z, vx: 0, vy: 0, vz: 0, f, a: f, fl: 0, st: 0, sw: 0, ...extra };
}

export async function run() {
    const { ok, result } = suite();

    // ---- interpolation between two frames ---------------------------------
    {
        const d = new RemoteDriver();
        const p = mkPlayer("b", 0, 0);
        // Server time runs 10 s ahead of ours, which is the normal case: two unrelated
        // clocks. Nothing may depend on them agreeing.
        d.accept(10.0, { b: st(0, 0) }, 0.0);
        d.accept(10.05, { b: st(10, 0) }, 0.05);

        // Render time is the newest minus the delay, so with a 0.1 s delay and 0.05 s of
        // history we are looking before the first frame and should sit on it.
        d.apply(p, 0.05);
        ok(p.controller.position.x === 0,
            "with less history than the delay, a remote sits on its oldest frame, got " +
            p.controller.position.x);

        // Push time forward so the render clock lands exactly between the two frames.
        d.accept(10.10, { b: st(20, 0) }, 0.10);
        d.accept(10.15, { b: st(30, 0) }, 0.15);
        // local 0.15 → server 10.15 → render 10.05, which is frame two exactly.
        d.apply(p, 0.15);
        ok(Math.abs(p.controller.position.x - 10) < 1e-6,
            "and lands on a frame when the clock says that frame, got " +
            p.controller.position.x);

        d.apply(p, 0.175); // render 10.075: half way between frames two and three
        ok(Math.abs(p.controller.position.x - 15) < 1e-6,
            "and half way between two frames when it is half way, got " +
            p.controller.position.x);
    }

    // ---- the delay is real -------------------------------------------------
    {
        const d = new RemoteDriver();
        d.accept(100, {}, 0);
        ok(Math.abs(d.renderTime(0) - (100 - INTERP_DELAY)) < 1e-9,
            "remotes are drawn a fixed delay behind the newest snapshot");
        ok(d.offset === 100, "the clock offset is learned from the first snapshot");
    }

    // ---- a stalled feed stands still rather than gliding away --------------
    {
        const d = new RemoteDriver();
        const p = mkPlayer("b", 0, 0);
        d.accept(1.0, { b: st(0, 0) }, 0);
        d.accept(1.05, { b: st(1, 0) }, 0.05);
        // Their client stops talking. Ten seconds later we must be standing on the last
        // known position, not a hundred metres past it — extrapolation would keep a
        // disconnected player sliding into the distance forever.
        d.apply(p, 10);
        ok(Math.abs(p.controller.position.x - 1) < 1e-6,
            "a silent client's player holds its last position, got " +
            p.controller.position.x);
    }

    // ---- angles take the short way round ----------------------------------
    {
        const d = new RemoteDriver();
        const p = mkPlayer("b", 0, 0);
        // Just under +pi to just over -pi: three degrees of turn across the wrap, which
        // a naive lerp renders as 357 degrees the other way.
        d.accept(1.0, { b: st(0, 0, Math.PI - 0.03) }, 0);
        d.accept(1.05, { b: st(0, 0, -Math.PI + 0.03) }, 0.05);
        d.apply(p, 1.05 - 1.0 + INTERP_DELAY - 0.025);
        const f = p.controller.facing;
        // Anywhere near +/-pi is right; anywhere near zero means it spun the long way.
        ok(Math.abs(Math.abs(f) - Math.PI) < 0.05,
            "facing wraps the short way, got " + f.toFixed(3));
    }

    // ---- out-of-order frames are dropped ----------------------------------
    {
        const d = new RemoteDriver();
        const p = mkPlayer("b", 0, 0);
        d.accept(2.0, { b: st(100, 0) }, 0);
        d.accept(1.0, { b: st(0, 0) }, 0.05); // stale, arriving late
        d.apply(p, 5);
        ok(Math.abs(p.controller.position.x - 100) < 1e-6,
            "a stale frame does not drag the interpolation backwards, got " +
            p.controller.position.x);
    }

    // ---- history is bounded ------------------------------------------------
    {
        const d = new RemoteDriver();
        for (let i = 0; i < 500; i++) d.accept(i * 0.05, { b: st(i, 0) }, i * 0.05);
        const track = d.tracks.get("b");
        ok(track.frames.length <= 30,
            "history is capped rather than growing for the length of the session, got " +
            track.frames.length);
    }

    // ---- an unknown player applies nothing --------------------------------
    {
        const d = new RemoteDriver();
        const p = mkPlayer("ghost", 3, 4);
        ok(d.apply(p, 1) === false, "a player with no snapshots reports that it has none");
        ok(p.controller.position.x === 3, "and is left where it was");
    }

    // ---- forgetting a player ----------------------------------------------
    {
        const d = new RemoteDriver();
        const p = mkPlayer("b", 0, 0);
        d.accept(1, { b: st(5, 0) }, 0);
        d.forget("b");
        ok(d.apply(p, 1) === false,
            "a player who left leaves no history behind for a rejoin to inherit");
    }

    // ---- flags survive the round trip -------------------------------------
    {
        const bits = st(0, 0, 0, { fl: F_SURF | F_DEAD });
        const f = stateFlags(bits);
        ok(f.surf === true, "surf unpacks");
        ok(f.dead === true, "dead unpacks");
        ok(f.air === false, "and a bit that was not set stays unset");
    }

    // ---- what the wire carries about a swing -------------------------------
    {
        const p = mkPlayer("a", 1, 2);
        p.controller.facing = 0.5;
        p.controller.intent = { aimYaw: 1.25, sprint: true };
        p.combat.stage = 2;
        p.combat.t = 0.123;
        const s = encodeState(p);
        ok(s.st === 2, "the combo stage is on the wire — a remote blade has to be posed");
        ok(Math.abs(s.sw - 0.123) < 1e-6, "and its phase clock, to millisecond precision");
        ok(Math.abs(s.a - 1.25) < 1e-3,
            "aim travels separately from facing, because a strafing player aims " +
            "somewhere other than where they are pointed");
        ok(Math.abs(s.f - 0.5) < 1e-3, "and facing is what the body does");
    }

    // ---- the clock estimate settles toward the floor -----------------------
    {
        const d = new RemoteDriver();
        // A first snapshot that happened to be delayed, then honest ones. The offset must
        // migrate toward the smallest observation, because a delayed frame can only ever
        // make the server look later than it is.
        d.accept(5.5, {}, 0);
        ok(d.offset === 5.5, "the first observation is taken as-is");
        for (let i = 1; i < 40; i++) d.accept(5.0 + i * 0.05, {}, i * 0.05);
        for (let i = 0; i < 10; i++) d.tick(0.2);
        ok(d.offset < 5.5,
            "and is pulled toward the least-delayed one, got " + d.offset.toFixed(3));
        ok(d.offset > 4.9, "without overshooting past it, got " + d.offset.toFixed(3));
    }

    return result();
}
