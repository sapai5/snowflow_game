/**
 * The slash arc's geometry.
 *
 * Split from the effect that draws it because it is all arithmetic on flat arrays — no
 * scene, no device, no Babylon — which means the shape can be tested rather than
 * inspected. The trail's equivalent maths lives inside its own module and has to be
 * checked by reading the source as text; that was a mistake worth not repeating.
 *
 * What this builds is a *sheet*, not a ribbon. The trail is a thin contrail hugging the
 * last hand's-width of the edge; this is the whole surface the blade swept — hilt to
 * beyond the point, across the entire arc — which is what the reference art is. They are
 * different effects and both are wanted: the contrail says where the edge went, the sheet
 * says how much of the world the swing covered.
 */

/** Recorded blade positions in one swing. A strike lasts 0.17–0.34 s, so 22 is ample. */
export const ARC_SAMPLES = 22;

/**
 * Spline stations per recorded sample.
 *
 * The same reasoning as the trail: at the velocity peak the tip moves up to 17 degrees
 * between frames, and a sheet built straight from the samples is a visible fan of flat
 * facets. Interpolating the *control points* rather than subdividing the polygons is the
 * only thing that adds curvature, because subdividing a straight segment leaves it
 * straight.
 */
export const ARC_SUBDIV = 4;
export const ARC_STATIONS = (ARC_SAMPLES - 1) * ARC_SUBDIV + 1;

/**
 * Vertices across the sheet.
 *
 * Six, with the outer two pairs bunched near the rims. The fragment shader computes the
 * rim falloff analytically from `uv.y`, so the columns are not what makes the edge soft —
 * they are what stops the *silhouette* being a hexagon when the sheet curls toward the
 * camera. Bunching them at the rims puts the geometry where the brightness gradient is
 * steepest.
 */
export const ARC_COLUMNS = 6;
export const ARC_ACROSS = [0, 0.12, 0.34, 0.66, 0.88, 1];

/**
 * How far the sheet reaches along the blade axis, as a fraction of the recorded segment.
 *
 * The recorded segment is guard to point. Negative at the inner end so the sheet starts
 * just inside the hilt rather than exactly at it — a sheet that begins precisely at the
 * guard leaves a visible seam against the hand. Well past 1 at the outer end because the
 * reference arcs extend a good half-blade beyond the point, which is what makes them read
 * as a shockwave the blade threw rather than as a surface it painted.
 */
export const SPAN_IN = -0.08;
export const SPAN_OUT = 1.52;

/**
 * How much of the outward reach the oldest end keeps.
 *
 * The taper. Without it the sheet is a uniform band with a blunt tail; with it the arc
 * narrows behind the blade, which is both what the reference does and what makes the
 * direction of the swing readable from a still frame.
 */
export const TAIL_SCALE = 0.42;

/**
 * Catmull-Rom through flat control points.
 *
 * Interpolating rather than approximating, for the same reason the trail does: the sheet
 * has to pass through the positions the blade actually occupied. A B-spline would smooth
 * the arc away from them and put light where the edge never was.
 *
 * Ends clamp their missing neighbour onto themselves, so the first and last spans curve
 * instead of shooting toward a phantom point.
 *
 * @param {Float32Array} p control points, three floats each
 * @param {number} n how many are live
 * @param {number} i span index
 * @param {number} t 0..1 within the span
 * @param {Float32Array} out
 * @param {number} o offset into `out`
 */
export function arcSpline(p, n, i, t, out, o) {
    const i0 = Math.max(0, i - 1);
    const i1 = i;
    const i2 = Math.min(n - 1, i + 1);
    const i3 = Math.min(n - 1, i + 2);

    const t2 = t * t;
    const t3 = t2 * t;
    // The uniform Catmull-Rom basis, written out. A matrix multiply here would be three
    // more multiplies per component for no clarity.
    const b0 = -0.5 * t3 + t2 - 0.5 * t;
    const b1 = 1.5 * t3 - 2.5 * t2 + 1.0;
    const b2 = -1.5 * t3 + 2.0 * t2 + 0.5 * t;
    const b3 = 0.5 * t3 - 0.5 * t2;

    for (let k = 0; k < 3; k++) {
        out[o + k] =
            p[i0 * 3 + k] * b0 +
            p[i1 * 3 + k] * b1 +
            p[i2 * 3 + k] * b2 +
            p[i3 * 3 + k] * b3;
    }
}

/**
 * Build every vertex of the sheet.
 *
 * Both edges are splined independently and the cross-section is then measured from the
 * *interpolated* pair, rather than the span being precomputed per sample and
 * interpolated. Interpolating a precomputed span cuts the corners the spline is rounding,
 * so the sheet would pinch exactly where the arc is tightest — the same trap the trail's
 * feather margins fell into.
 *
 * Degenerate input is survivable by design: fewer than two samples collapses everything
 * onto the newest position, which draws nothing rather than producing NaNs that would
 * make the whole mesh vanish.
 *
 * @param {Float32Array} inner guard positions, newest first
 * @param {Float32Array} outer point positions, newest first
 * @param {number} count live samples
 * @param {Float32Array} verts ARC_STATIONS * ARC_COLUMNS * 3
 */
export function buildArcVertices(inner, outer, count, verts) {
    if (count < 2) {
        // One sample is not a swing. Everything to a point: zero area, nothing drawn.
        const x = count === 1 ? inner[0] : 0;
        const y = count === 1 ? inner[1] : 0;
        const z = count === 1 ? inner[2] : 0;
        for (let i = 0; i < ARC_STATIONS * ARC_COLUMNS; i++) {
            verts[i * 3] = x;
            verts[i * 3 + 1] = y;
            verts[i * 3 + 2] = z;
        }
        return;
    }

    const spans = count - 1;
    for (let s = 0; s < ARC_STATIONS; s++) {
        // Position along the whole recorded path, 0 at the newest sample.
        const u = (s / (ARC_STATIONS - 1)) * spans;
        let i = Math.floor(u);
        let f = u - i;
        if (i >= spans) {
            i = spans - 1;
            f = 1;
        }

        arcSpline(inner, count, i, f, _in, 0);
        arcSpline(outer, count, i, f, _out, 0);

        // The blade axis at this station, and its length. Both come from the interpolated
        // pair so the sheet's width follows the curve rather than the chords.
        let ax = _out[0] - _in[0];
        let ay = _out[1] - _in[1];
        let az = _out[2] - _in[2];
        const len = Math.hypot(ax, ay, az);
        if (len > 1e-6) {
            ax /= len;
            ay /= len;
            az /= len;
        }

        // Newness: 1 at the leading edge, 0 at the tail. The outward reach tapers with
        // it; the inner edge does not, because the hilt end of a swing does not move
        // away from the hand.
        const newness = 1 - s / (ARC_STATIONS - 1);
        const reach = SPAN_OUT * (TAIL_SCALE + (1 - TAIL_SCALE) * newness);

        for (let c = 0; c < ARC_COLUMNS; c++) {
            const t = SPAN_IN + (reach - SPAN_IN) * ARC_ACROSS[c];
            const d = len * t;
            const o = (s * ARC_COLUMNS + c) * 3;
            verts[o] = _in[0] + ax * d;
            verts[o + 1] = _in[1] + ay * d;
            verts[o + 2] = _in[2] + az * d;
        }
    }
}

/**
 * The static attribute table.
 *
 * `uv.x` is progress toward the leading edge: 0 is the oldest station, 1 is where the
 * blade is now. Deliberately the opposite sense to the trail's, whose `uv.x` is age — a
 * sheet is read from its tail toward the edge that is cutting, and a shader that has to
 * write `1 - uv.x` everywhere invites exactly one of them to be forgotten.
 *
 * `uv.y` is across the sheet, 0 at the hilt rim and 1 at the far rim. Both are feather
 * edges; the bright core is in between.
 *
 * @param {Float32Array} uvs
 */
export function buildArcUVs(uvs) {
    for (let s = 0; s < ARC_STATIONS; s++) {
        const along = 1 - s / (ARC_STATIONS - 1);
        for (let c = 0; c < ARC_COLUMNS; c++) {
            const o = (s * ARC_COLUMNS + c) * 2;
            uvs[o] = along;
            uvs[o + 1] = ARC_ACROSS[c];
        }
    }
}

/** @param {Uint32Array} idx (ARC_STATIONS-1) * (ARC_COLUMNS-1) * 6 */
export function buildArcIndices(idx) {
    let w = 0;
    for (let s = 0; s < ARC_STATIONS - 1; s++) {
        for (let c = 0; c < ARC_COLUMNS - 1; c++) {
            const a = s * ARC_COLUMNS + c;
            const b = a + ARC_COLUMNS;
            idx[w++] = a; idx[w++] = a + 1; idx[w++] = b + 1;
            idx[w++] = a; idx[w++] = b + 1; idx[w++] = b;
        }
    }
    return w;
}

const _in = new Float32Array(3);
const _out = new Float32Array(3);
