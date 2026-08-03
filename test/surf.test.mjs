/**
 * Snow-surf physics, against the real controller.
 *
 * This suite exists because surfing was shipped with the fall line inverted: a rider
 * pointed downhill was pushed backwards and a rider pointed uphill was fired up the
 * mountain. Nothing caught it, because nothing here had ever been run — the resolver
 * hook could not load a module that reached Babylon's Scalar, so the controller was
 * untestable in principle.
 *
 * The slopes are synthetic and analytic, which is the point: on a plane that descends
 * toward +x, "downhill" is a known direction rather than something to be inferred from
 * the heightfield, so a sign error has nowhere to hide.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { CharacterController } from "../src/character/controller.js";
import { makeIntent } from "../src/game/intent.js";
import { suite } from "./harness.mjs";

/** A plane of constant grade descending toward +x. `drop` is metres per metre. */
function ramp(drop) {
    return {
        heightAt: (x) => -x * drop,
        normalAt(x, z, out) {
            const e = 1;
            const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
            const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
            out.set(-hx / (2 * e), 1, -hz / (2 * e));
            out.normalize();
            return out;
        },
        sampleAt: () => 0,
        slopeAt: () => 0,
        deform: () => {},
        clampToPlayArea: () => {},
    };
}

const rig = {
    yaw: 0,
    addTrauma() {},
    getFlatForward: (o) => o.set(0, 0, 1),
    getFlatRight: (o) => o.set(1, 0, 0),
};

/** Surf for `secs` facing `yaw`, and report the speed along that heading. */
function surfFor(terrain, yaw, secs, tweak) {
    const ch = new CharacterController(terrain);
    ch.position.set(0, terrain.heightAt(0, 0), 0);
    ch.facing = yaw;
    // Already committed to the board, so the blend is not what is under test.
    ch.surf = 1;
    ch.surfActive = true;
    const input = makeIntent();
    input.surf = true;
    input.faceYaw = yaw;
    input.aimYaw = yaw;
    if (tweak) tweak(ch, input);

    const dt = 1 / 60;
    for (let f = 0; f < Math.round(secs / dt); f++) {
        rig.yaw = ch.facing; // no steering input from the camera
        ch.update(dt, rig, input);
    }
    const fx = Math.sin(ch.facing);
    const fz = Math.cos(ch.facing);
    return {
        ch,
        speed: Math.hypot(ch.velocity.x, ch.velocity.z),
        forward: ch.velocity.x * fx + ch.velocity.z * fz,
    };
}

export async function run() {
    const { ok, result } = suite();

    // Descends toward +x, so downhill is yaw = +90 degrees and uphill is -90.
    const slope = ramp(0.5); // 26.6 degrees
    const DOWN = Math.PI / 2;
    const UP = -Math.PI / 2;

    // ---- the fall line, which is the whole bug ----------------------------
    {
        const down = surfFor(slope, DOWN, 1.5);
        const up = surfFor(slope, UP, 1.5);
        ok(down.forward > 0, "pointed downhill, the rider goes forwards, got " +
            down.forward.toFixed(2) + " m/s");
        ok(down.forward > up.forward,
            "downhill is faster than uphill: " + down.forward.toFixed(2) +
            " vs " + up.forward.toFixed(2));
        ok(down.speed > 8, "and a descent actually builds speed, got " + down.speed.toFixed(1));
        // The inverted version rocketed *up* the hill. This is the assertion that fails
        // if the sign is ever flipped back.
        ok(up.speed < down.speed * 0.8,
            "climbing is slower than descending, got " + up.speed.toFixed(1) +
            " vs " + down.speed.toFixed(1));
    }

    // ---- terrain can never reverse the rider's own drive ------------------
    {
        // A wall, far steeper than anything the old formula could survive: at 45 degrees
        // the inverted slope term was -18.4 against a base of 8.5.
        const cliff = ramp(1.0);
        const up = surfFor(cliff, UP, 0.4);
        ok(Number.isFinite(up.speed), "a steep climb stays finite");
        // Gravity may well drag the rider back down the hill; what must not happen is the
        // *drive* turning negative and doing it on purpose.
        const flat = ramp(0);
        const level = surfFor(flat, 0, 0.4);
        ok(level.forward > 0, "on the level the rider always drives forwards, got " +
            level.forward.toFixed(2));
    }

    // ---- the brake brakes, and never reverses ----------------------------
    {
        const flat = ramp(0);
        const free = surfFor(flat, 0, 2.0);
        let minForward = Infinity;
        const braked = surfFor(flat, 0, 2.0, (ch, input) => {
            input.moveZ = -1;
        });
        ok(braked.speed < free.speed,
            "pulling back scrubs speed: " + braked.speed.toFixed(2) +
            " against " + free.speed.toFixed(2));
        ok(braked.forward >= -1e-6,
            "and never drives backwards, got " + braked.forward.toFixed(3) + " m/s");

        // Held from a standstill, it must settle at or above zero rather than reversing.
        const ch = new CharacterController(flat);
        ch.surf = 1; ch.surfActive = true; ch.facing = 0;
        const input = makeIntent();
        input.surf = true; input.moveZ = -1; input.faceYaw = 0; input.aimYaw = 0;
        for (let f = 0; f < 180; f++) {
            rig.yaw = ch.facing;
            ch.update(1 / 60, rig, input);
            minForward = Math.min(minForward, ch.velocity.z);
        }
        ok(minForward >= -1e-6,
            "braking from rest never pushes the rider backwards, worst was " +
            minForward.toFixed(4));
    }

    // ---- a buried board is slow, not welded ------------------------------
    {
        // The window that matters is the moment after a landing, not a second later:
        // plough recovers at 1.3 per second, so a constant plough drag only pinned the
        // rider for the first ~0.4 s. That is still long enough to read as "surf did not
        // work", because it is exactly when the button gets pressed.
        const flat = ramp(0);
        const buriedEarly = surfFor(flat, 0, 0.3, (ch) => { ch.plow = 1; });
        ok(buriedEarly.speed > 0.35,
            "a board buried by a landing starts moving straight away, got " +
            buriedEarly.speed.toFixed(2) + " m/s in the first 0.3 s");

        const clean = surfFor(flat, 0, 1.2);
        const buried = surfFor(flat, 0, 1.2, (ch) => { ch.plow = 1; });
        ok(buried.speed < clean.speed,
            "but a ploughed board is still slower than a clean one: " +
            buried.speed.toFixed(2) + " against " + clean.speed.toFixed(2));
    }

    // ---- a traverse is pulled toward the fall line -----------------------
    {
        // Across the slope: downhill is +x, so heading +z is a pure traverse.
        const t = surfFor(slope, 0, 1.2);
        ok(t.ch.velocity.x > 0.1,
            "holding a line across a face drags the rider downhill, got " +
            t.ch.velocity.x.toFixed(2) + " m/s of drift");
    }

    // ---- terminal speed still holds -------------------------------------
    {
        const steep = ramp(0.8);
        const long = surfFor(steep, DOWN, 12);
        ok(long.speed <= 13.0001,
            "drag and the clamp keep a long descent at terminal, got " +
            long.speed.toFixed(2));
    }

    return result();
}
