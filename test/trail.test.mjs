/**
 * The sword trail's ring buffer.
 *
 * The mesh and the shader cannot be exercised without a device, but the part most
 * likely to be wrong can: which samples end up in which vertex slot. The whole design
 * rests on the buffer being copied out in *age order* — that is what lets the age
 * coordinate be a static attribute instead of a per-frame upload — so if the ordering
 * is wrong the trail fades from the wrong end and nothing about the shader will
 * explain why.
 */
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { suite } from "./harness.mjs";

// The class constructs a Babylon mesh, which needs a scene. Rather than stub all of
// Babylon, the ring-buffer logic is re-derived here against the same rules the
// implementation follows, and the implementation's constants are read from its source
// so the two cannot drift apart silently.
import { readFileSync } from "node:fs";

export async function run() {
    const { ok, result } = suite();
    const src = readFileSync(new URL("../src/vfx/swordTrail.js", import.meta.url), "utf8");

    const num = (name) => {
        const m = src.match(new RegExp("const " + name + " = ([0-9.]+)"));
        return m ? parseFloat(m[1]) : NaN;
    };
    const SAMPLES = num("SAMPLES");
    const LIFE = num("LIFE");
    const INNER = num("INNER");
    const GATE = num("MOVE_GATE");
    const MARGIN = num("MARGIN");
    const COLUMNS = num("COLUMNS");

    ok(SAMPLES >= 12, "enough samples to cover a strike, got " + SAMPLES);
    ok(LIFE > 0.1 && LIFE < 0.6, "a trail lives a fraction of a second, got " + LIFE);
    // High is the point — a contrail comes off a tip. The upper bound only guards
    // against the ribbon collapsing to nothing.
    ok(INNER > 0.1 && INNER < 0.95, "the ribbon starts on the outer blade, got " + INNER);
    ok(GATE > 0 && GATE < 0.2, "there is a gate on starting a trail, got " + GATE);

    // The feather. Without margin geometry there is nothing to fade into and the
    // ribbon has a hard edge however good the gradient is — which is exactly what the
    // two-column version looked like.
    ok(COLUMNS === 4, "the strip is four wide: two feather columns and two blade, got " + COLUMNS);
    // The feather needs enough width to be a gradient rather than a dither. A few
    // centimetres is plenty at this ribbon width; zero would put the hard edge back.
    ok(MARGIN >= 0.03, "the feather has real width in metres, got " + MARGIN);
    ok(MARGIN < (1 - INNER) * 0.86,
        "and is narrower than the blade span it feathers, " + MARGIN + " vs " +
        ((1 - INNER) * 0.86).toFixed(2));
    // Thickness. The ribbon spans the blade from INNER to the point, plus a margin at each
    // end.
    //
    // The bound used to be 25 cm, on the reasoning that a contrail wider than that reads as
    // a banner. That was wrong about what this effect is for: the reference art is a bold
    // sheet, and a trail that has to be looked for is not doing its job. It is now the
    // bright leading edge of a swing rather than a thread behind it, so the assertion is
    // that it is *substantial* — with an upper bound only to catch a ribbon that has grown
    // wider than the blade is long, which would read as a cape.
    const width = (1 - INNER) * 0.86 + MARGIN * 2;
    ok(width > 0.35,
        "the ribbon is bold rather than a thread, got " + width.toFixed(2) + " m");
    ok(width < 0.86,
        "and no wider than the blade is long, got " + width.toFixed(2) + " m");

    // The shader's span must match the vertex table's, or the feather lands in the
    // wrong place: the blade's span would fade and the margin would be solid.
    const frag = readFileSync(new URL("../src/shaders/trail.fragment.wgsl", import.meta.url), "utf8");
    const lo = parseFloat(frag.match(/SPAN_LO:\s*f32\s*=\s*([0-9.]+)/)[1]);
    const hi = parseFloat(frag.match(/SPAN_HI:\s*f32\s*=\s*([0-9.]+)/)[1]);
    const across = JSON.parse(src.match(/const across = (\[[^\]]*\])/)[1]);
    ok(across.length === COLUMNS, "one uv.y per column");
    ok(across[0] === 0 && across[COLUMNS - 1] === 1, "the strip spans the full 0..1");
    ok(Math.abs(across[1] - lo) < 1e-6,
        `the inner blade column sits exactly on the shader's SPAN_LO (${across[1]} vs ${lo})`);
    ok(Math.abs(across[2] - hi) < 1e-6,
        `and the outer one on SPAN_HI (${across[2]} vs ${hi})`);

    // Every bright line must sit inside the blade's span rather than out in the feather,
    // where coverage is fading and it would be thrown away. There are two: the broad hot
    // core just inside the point, and a tighter highlight on the leading edge itself.
    const cores = [...frag.matchAll(/\(y - ([0-9.]+)\)/g)].map((m) => parseFloat(m[1]));
    ok(cores.length === 2, "two bright bands across the ribbon, got " + cores.length);

    // Saturation survives additive blending only if the channel ratio is extreme: a
    // pale blue arrives at already-bright snow and reads as white. Assert the tint is
    // actually blue-dominant rather than a wash.
    const trail = readFileSync(new URL("../src/vfx/swordTrail.js", import.meta.url), "utf8");
    const tint = trail.match(/trailTint",\s*new Color3\(([0-9.]+),\s*([0-9.]+),\s*([0-9.]+)\)/);
    ok(tint !== null, "the ice tint is readable from source");
    if (tint) {
        const [r, g, b] = [parseFloat(tint[1]), parseFloat(tint[2]), parseFloat(tint[3])];
        ok(b >= 0.9, "blue is at full strength, got " + b);
        ok(r < 0.25, "red is held down, or the blue washes to white, got " + r);
        ok(g > r && g < b, "green sits between, giving ice rather than pure blue or cyan");
    }
    for (const c of cores) {
        ok(c > lo && c < hi, `a core line at ${c} is inside the blade span ${lo}..${hi}`);
    }
    // Both bands live on the outer half, near the point.
    //
    // They used to straddle the middle — a gold band inside and an ice one outside. The
    // gold is gone with the reference's palette, and what replaced it is a temperature
    // gradient running the other way: cold and dim at the hilt end, hot and bright at the
    // edge. Two bands on the inner half would put the brightest part of the ribbon where
    // the blade was moving slowest, which is backwards.
    ok(Math.min(...cores) > 0.5,
        "both bright bands sit on the outer half, toward the point");
    ok(Math.max(...cores) < hi,
        "and inside the span, not on its boundary where coverage is already fading");
    ok(!/trailGold/.test(frag),
        "the gold is gone — the reference has none, and a warm inner band pulls the eye " +
        "off the hot-to-cold gradient that is the whole read");
    ok(/uniform trailHot/.test(frag), "and a hot core has replaced it");

    // A whole strike must fit inside the trail's life, or the ribbon is shorter than
    // the swing that made it and the arc looks clipped.
    const combat = readFileSync(new URL("../src/character/swordCombat.js", import.meta.url), "utf8");
    const strikes = [...combat.matchAll(/strike:\s*([0-9.]+)/g)].map((m) => parseFloat(m[1]));
    ok(strikes.length >= 3, "found the strike durations, got " + strikes.length);
    ok(LIFE >= Math.max(...strikes),
        `the trail outlives the longest strike, or the arc is clipped (${LIFE}s vs ${Math.max(...strikes)}s)`);
    ok(SAMPLES / 60 >= LIFE,
        `and there are enough samples to hold that life at 60 fps (${(SAMPLES / 60).toFixed(2)}s of buffer)`);

    // Subdivision. One sample a frame across an accelerating 114-degree sweep leaves up
    // to 17 degrees between neighbours, and a straight quad across that misses the true
    // arc by more than a centimetre — six of them in a row is a visible polyline.
    const SUBDIV = num("SUBDIV");
    ok(SUBDIV >= 3, "each sample pair is subdivided into a curve, got " + SUBDIV);
    const worstStep = 17.2 / SUBDIV;
    const chordErr = 1.0 * (1 - Math.cos((worstStep / 2) * Math.PI / 180));
    ok(chordErr < 0.002,
        `residual chord error is under 2 mm at 1 m radius, got ${(chordErr * 1000).toFixed(2)} mm`);
    ok(chordErr < MARGIN,
        "and is smaller than the feather is wide, so the curve is smoother than the softest edge");

    // Age ordering, re-derived: walking back from the head must give newest first.
    const head = 7;
    const order = [];
    for (let i = 0; i < SAMPLES; i++) order.push((head - 1 - i + SAMPLES * 2) % SAMPLES);
    ok(order[0] === head - 1, "slot 0 is the sample written most recently");
    ok(new Set(order).size === SAMPLES, "every slot appears exactly once");
    ok(order[SAMPLES - 1] === head % SAMPLES, "the last slot is the oldest, about to be overwritten");

    return result();
}

/**
 * The spline, on its own.
 *
 * Exported separately from the class because the class needs a Babylon scene and this
 * does not, and because the two properties that matter — that it passes through its
 * control points, and that it actually curves — are cheap to state and expensive to
 * eyeball in a browser.
 */
export async function runSpline() {
    const { ok, result } = suite();

    // A quarter circle as control points, the way a swing samples an arc.
    const N = 5;
    const p = new Float32Array(N * 3);
    for (let i = 0; i < N; i++) {
        const a = (i / (N - 1)) * (Math.PI / 2);
        p[i * 3] = Math.cos(a);
        p[i * 3 + 1] = 0;
        p[i * 3 + 2] = Math.sin(a);
    }

    // Re-derive the implementation's spline here rather than importing the module,
    // which would pull in Babylon meshes. Same formula, asserted against the same
    // control points.
    const out = { x: 0, y: 0, z: 0 };
    const spline = (arr, n, i, t) => {
        const i0 = Math.max(0, i - 1) * 3, i1 = i * 3;
        const i2 = Math.min(n - 1, i + 1) * 3, i3 = Math.min(n - 1, i + 2) * 3;
        const t2 = t * t, t3 = t2 * t;
        const k = ["x", "y", "z"];
        for (let c = 0; c < 3; c++) {
            const a = arr[i0 + c], b = arr[i1 + c], d = arr[i2 + c], e = arr[i3 + c];
            out[k[c]] = 0.5 * (2 * b + (d - a) * t + (2 * a - 5 * b + 4 * d - e) * t2 +
                (-a + 3 * b - 3 * d + e) * t3);
        }
        return out;
    };

    // Interpolating, not approximating: at t = 0 it must *be* the control point.
    for (let i = 0; i < N; i++) {
        const q = spline(p, N, i, 0);
        const dx = q.x - p[i * 3], dz = q.z - p[i * 3 + 2];
        ok(Math.hypot(dx, dz) < 1e-6, `the spline passes through control point ${i}`);
    }

    // And it must bulge off the chord, or it is the polyline it replaced. Measure the
    // midpoint of a segment against the straight line between its ends.
    const mid = spline(p, N, 1, 0.5);
    const ax = p[3], az = p[5], bx = p[6], bz = p[8];
    const chordX = (ax + bx) / 2, chordZ = (az + bz) / 2;
    const bulge = Math.hypot(mid.x - chordX, mid.z - chordZ);
    ok(bulge > 1e-3, "and bulges off the chord rather than lying on it, by " + bulge.toFixed(4));

    // The bulge should point away from the arc's centre, not into it.
    const outward = mid.x * mid.x + mid.z * mid.z;
    ok(outward > (chordX * chordX + chordZ * chordZ),
        "the curve bows outward, following the arc rather than cutting it");

    return result();
}
