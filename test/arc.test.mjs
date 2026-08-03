/**
 * The slash arc's geometry and shading.
 *
 * The mesh maths is a real import here rather than a regex over the source, because it was
 * deliberately kept free of Babylon for that reason — the trail's equivalent has to be
 * checked by reading its own file as text, which catches typos and nothing else.
 *
 * What is asserted is the shape: that the sheet spans the blade and beyond, that it curves
 * rather than faceting, that it tapers behind the swing, and that degenerate input draws
 * nothing instead of producing NaNs. A NaN in one vertex removes the entire mesh, which in
 * a game looks exactly like the effect not being wired up.
 */
import { readFileSync } from "node:fs";
import {
    ARC_SAMPLES, ARC_SUBDIV, ARC_STATIONS, ARC_COLUMNS, ARC_ACROSS,
    SPAN_IN, SPAN_OUT, TAIL_SCALE,
    arcSpline, buildArcVertices, buildArcUVs, buildArcIndices,
} from "../src/vfx/arcMesh.js";
import { suite } from "./harness.mjs";

/**
 * A swing: the blade sweeping an arc of `deg`, newest sample first.
 *
 * `hiltArc` moves the hand as well, which is what a real swing does — a fixed hilt makes
 * the inner rim a single point and hides anything that depends on it having length.
 */
function swing(count, deg, radius = 0.9, hiltArc = 0) {
    const inner = new Float32Array(ARC_SAMPLES * 3);
    const outer = new Float32Array(ARC_SAMPLES * 3);
    // A single sample has no span to divide by; it is a legitimate input and the helper
    // must not be the thing that produces the NaN the test is looking for.
    const hiltR = hiltArc > 0 ? 0.25 : 0;
    for (let i = 0; i < count; i++) {
        // Newest first, so sample 0 is the end of the swing.
        const k = count > 1 ? (count - 1 - i) / (count - 1) : 0;
        const a = k * (deg * Math.PI / 180);
        const h = k * (hiltArc * Math.PI / 180);
        inner[i * 3] = Math.cos(h) * hiltR;
        inner[i * 3 + 1] = 1.2;
        inner[i * 3 + 2] = Math.sin(h) * hiltR;
        outer[i * 3] = Math.cos(a) * radius;
        outer[i * 3 + 1] = 1.2;
        outer[i * 3 + 2] = Math.sin(a) * radius;
    }
    return { inner, outer };
}

const at = (v, s, c) => {
    const o = (s * ARC_COLUMNS + c) * 3;
    return { x: v[o], y: v[o + 1], z: v[o + 2] };
};
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z);

export async function run() {
    const { ok, result } = suite();
    const verts = new Float32Array(ARC_STATIONS * ARC_COLUMNS * 3);

    // ---- the sheet spans the blade and reaches past it ---------------------
    {
        const { inner, outer } = swing(12, 100);
        buildArcVertices(inner, outer, 12, verts);

        // At the newest station the sheet is at full reach.
        const hilt = at(verts, 0, 0);
        const tip = at(verts, 0, ARC_COLUMNS - 1);
        const bladeLen = 0.9;
        const width = dist(hilt, tip);
        ok(width > bladeLen,
            "the sheet is wider than the blade — that is what makes it a shockwave " +
            "rather than a decal painted on the edge: got " + width.toFixed(2) + " m");
        ok(Math.abs(width - bladeLen * (SPAN_OUT - SPAN_IN)) < 0.02,
            "and exactly as wide as the span constants say, got " + width.toFixed(3));

        // The inner rim sits just inside the hilt, not on it.
        const guard = { x: 0, y: 1.2, z: 0 };
        const inset = dist(hilt, guard);
        ok(inset > 0.001,
            "the inner rim is offset from the guard, so there is no seam at the hand");
        ok(Math.abs(inset - bladeLen * Math.abs(SPAN_IN)) < 0.01,
            "by the amount SPAN_IN asks for, got " + inset.toFixed(3));
    }

    // ---- it tapers behind the swing ---------------------------------------
    {
        const { inner, outer } = swing(12, 100);
        buildArcVertices(inner, outer, 12, verts);
        const newWidth = dist(at(verts, 0, 0), at(verts, 0, ARC_COLUMNS - 1));
        const oldWidth = dist(
            at(verts, ARC_STATIONS - 1, 0),
            at(verts, ARC_STATIONS - 1, ARC_COLUMNS - 1)
        );
        ok(oldWidth < newWidth,
            "the tail is narrower than the leading edge: " + oldWidth.toFixed(2) +
            " against " + newWidth.toFixed(2));
        // The taper is what makes the direction of a swing readable from a still frame.
        ok(oldWidth / newWidth < 0.85,
            "and narrow enough to read as a taper, ratio " +
            (oldWidth / newWidth).toFixed(2));
        ok(oldWidth > 0.1, "without pinching to nothing, got " + oldWidth.toFixed(2));
    }

    // ---- the arc curves rather than faceting ------------------------------
    {
        const { inner, outer } = swing(8, 120);
        buildArcVertices(inner, outer, 8, verts);

        // The outer rim's stations should bow away from the straight line between the
        // first and last of them. A polyline through the samples would lie on the chords;
        // a spline through them does not.
        const a = at(verts, 0, ARC_COLUMNS - 1);
        const b = at(verts, ARC_STATIONS - 1, ARC_COLUMNS - 1);
        let maxOff = 0;
        for (let s = 1; s < ARC_STATIONS - 1; s++) {
            const p = at(verts, s, ARC_COLUMNS - 1);
            // Distance from p to the segment ab.
            const abx = b.x - a.x, aby = b.y - a.y, abz = b.z - a.z;
            const apx = p.x - a.x, apy = p.y - a.y, apz = p.z - a.z;
            const len2 = abx * abx + aby * aby + abz * abz;
            const t = len2 > 0 ? Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / len2)) : 0;
            const cx = a.x + abx * t - p.x;
            const cy = a.y + aby * t - p.y;
            const cz = a.z + abz * t - p.z;
            maxOff = Math.max(maxOff, Math.hypot(cx, cy, cz));
        }
        ok(maxOff > 0.1,
            "stations bow off the chord, so the sheet is curved, got " +
            maxOff.toFixed(2) + " m");

        // And the curvature is smooth: consecutive stations are near-equally spaced. This
        // is measured on the *inner* rim, which is the only column the taper does not
        // touch — the outer rim's spacing narrows toward the tail by design, so measuring
        // there would conflate a facet with the taper and the taper would win.
        const moving = swing(8, 120, 0.9, 60);
        buildArcVertices(moving.inner, moving.outer, 8, verts);
        //
        // Measured on the spline itself rather than on a built rim. Every rim in the mesh
        // is the control path *plus* an offset along the blade axis, and that axis rotates
        // through the whole arc — so a rim's spacing varies for reasons that have nothing
        // to do with the curve's smoothness, and either rim would conflate the two. What
        // "no faceting" actually means is that the parameterisation is smooth, which is a
        // property of the spline alone.
        //
        // The end spans are excluded: Catmull-Rom clamps its missing outer neighbour onto
        // itself, which shortens the tangent and so the span. That is the end condition
        // working, and it lands where the sheet is fading out anyway.
        const path = new Float32Array(ARC_STATIONS * 3);
        const spans = 8 - 1;
        for (let st = 0; st < ARC_STATIONS; st++) {
            const u = (st / (ARC_STATIONS - 1)) * spans;
            let i = Math.floor(u);
            let f = u - i;
            if (i >= spans) { i = spans - 1; f = 1; }
            arcSpline(outer, 8, i, f, path, st * 3);
        }
        let min = Infinity;
        let max = 0;
        for (let st = ARC_SUBDIV; st < ARC_STATIONS - 1 - ARC_SUBDIV; st++) {
            const d = Math.hypot(
                path[(st + 1) * 3] - path[st * 3],
                path[(st + 1) * 3 + 1] - path[st * 3 + 1],
                path[(st + 1) * 3 + 2] - path[st * 3 + 2]
            );
            min = Math.min(min, d);
            max = Math.max(max, d);
        }
        ok(max / min < 1.25,
            "the spline is smoothly parameterised — no clustering at the samples, which " +
            "is what a facet looks like: ratio " + (max / min).toFixed(3));
    }

    // ---- the spline passes through its control points ---------------------
    {
        const p = new Float32Array([0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
        const out = new Float32Array(3);
        arcSpline(p, 4, 1, 0, out, 0);
        ok(out[0] === 1 && out[1] === 2 && out[2] === 3,
            "t=0 lands exactly on the control point — the sheet must pass through where " +
            "the blade actually was, which is why this is Catmull-Rom and not a B-spline");
        arcSpline(p, 4, 1, 1, out, 0);
        ok(Math.abs(out[0] - 4) < 1e-6 && Math.abs(out[2] - 6) < 1e-6,
            "and t=1 on the next one");
    }

    // ---- degenerate input draws nothing, rather than NaN -----------------
    {
        const { inner, outer } = swing(1, 0);
        verts.fill(1);
        buildArcVertices(inner, outer, 1, verts);
        let finite = true;
        let area = 0;
        for (let i = 0; i < verts.length; i++) if (!Number.isFinite(verts[i])) finite = false;
        for (let s = 0; s < ARC_STATIONS; s++) {
            area += dist(at(verts, s, 0), at(verts, s, ARC_COLUMNS - 1));
        }
        ok(finite, "a single sample produces no NaN — one NaN vertex removes the whole mesh");
        ok(area === 0, "and zero area, so nothing is drawn");

        buildArcVertices(inner, outer, 0, verts);
        for (let i = 0; i < verts.length; i++) if (!Number.isFinite(verts[i])) finite = false;
        ok(finite, "and neither does no samples at all");
    }

    // ---- a stationary blade is survivable --------------------------------
    {
        // Every sample identical: the spline's tangents are all zero, which is exactly
        // where a normalise without a guard produces NaN.
        const inner = new Float32Array(ARC_SAMPLES * 3);
        const outer = new Float32Array(ARC_SAMPLES * 3);
        for (let i = 0; i < 10; i++) {
            inner[i * 3 + 1] = 1.2;
            outer[i * 3 + 1] = 1.2;
        }
        buildArcVertices(inner, outer, 10, verts);
        let finite = true;
        for (let i = 0; i < verts.length; i++) if (!Number.isFinite(verts[i])) finite = false;
        ok(finite, "a blade with zero length across the sheet produces no NaN");
    }

    // ---- the attribute table ---------------------------------------------
    {
        const uvs = new Float32Array(ARC_STATIONS * ARC_COLUMNS * 2);
        buildArcUVs(uvs);
        // uv.x is progress toward the leading edge: 1 at the newest station, 0 at the tail.
        ok(uvs[0] === 1, "uv.x is 1 at the newest station, where the blade is now");
        ok(uvs[(ARC_STATIONS - 1) * ARC_COLUMNS * 2] === 0, "and 0 at the tail");
        // uv.y spans both feather rims.
        ok(uvs[1] === 0 && uvs[(ARC_COLUMNS - 1) * 2 + 1] === 1,
            "uv.y runs 0 to 1 across the sheet, both rims included");
        ok(ARC_ACROSS[0] === 0 && ARC_ACROSS[ARC_COLUMNS - 1] === 1,
            "the column table agrees");
        // Columns bunched at the rims, where the brightness gradient is steepest.
        const firstGap = ARC_ACROSS[1] - ARC_ACROSS[0];
        const midGap = ARC_ACROSS[3] - ARC_ACROSS[2];
        ok(firstGap < midGap,
            "columns are denser at the rims than in the middle, " +
            firstGap.toFixed(2) + " against " + midGap.toFixed(2));
    }

    // ---- the index buffer ------------------------------------------------
    {
        const idx = new Uint32Array((ARC_STATIONS - 1) * (ARC_COLUMNS - 1) * 6);
        const written = buildArcIndices(idx);
        ok(written === idx.length, "every index is written, got " + written);
        let max = 0;
        for (const i of idx) max = Math.max(max, i);
        ok(max === ARC_STATIONS * ARC_COLUMNS - 1,
            "and the last vertex is referenced, so no station is orphaned");
    }

    // ---- the shader and the geometry agree -------------------------------
    {
        const frag = readFileSync(new URL("../src/shaders/slash.fragment.wgsl", import.meta.url), "utf8");
        const vert = readFileSync(new URL("../src/shaders/slash.vertex.wgsl", import.meta.url), "utf8");
        ok(/uniform slashCore/.test(frag) && /uniform slashRim/.test(frag),
            "the core and rim colours are uniforms, so they can be tuned live");
        ok(/uniform slashFade/.test(frag), "and the fade");
        ok(/uniform slashSeed/.test(frag), "and the per-swing seed");
        // The rim must feather over a narrower band than the core turns white over, or the
        // sheet is either hard-edged or has no blue left in it.
        const rim = frag.match(/let rim = smoothstep\(([\d.]+),\s*([\d.]+)/);
        const core = frag.match(/let core = smoothstep\(([\d.]+),\s*([\d.]+)/);
        ok(rim && core, "both falloffs are present");
        if (rim && core) {
            ok(Number(rim[2]) < Number(core[2]),
                "the rim feathers inside the band where the core turns white, " +
                rim[2] + " against " + core[2]);
        }
        ok(/vViewDist/.test(vert) && /vViewDist/.test(frag),
            "view distance reaches the fragment stage: additive light filling the frame " +
            "at arm's length is a white-out");
        // Every uniform the shader reads has to be declared to the material, or WebGPU
        // rejects the pipeline at first draw — a class of failure that only shows up in a
        // browser with a device.
        const src = readFileSync(new URL("../src/vfx/slashArc.js", import.meta.url), "utf8");
        for (const name of frag.matchAll(/uniform (\w+):/g)) {
            ok(src.includes('"' + name[1] + '"'),
                "the material declares " + name[1]);
        }
    }

    // ---- the buffer is bounded -------------------------------------------
    {
        ok(ARC_STATIONS === (ARC_SAMPLES - 1) * ARC_SUBDIV + 1,
            "stations follow from samples and subdivision");
        const tris = (ARC_STATIONS - 1) * (ARC_COLUMNS - 1) * 2;
        ok(tris < 1200,
            "the sheet is a few hundred triangles, not a few thousand: " + tris);
        ok(TAIL_SCALE > 0 && TAIL_SCALE < 1, "the taper is a fraction");
    }

    return result();
}
