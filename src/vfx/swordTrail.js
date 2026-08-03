/**
 * The sword trail.
 *
 * A ribbon swept from the path the outer half of the blade actually took, sampled
 * every frame and aged out over a fifth of a second. Same construction as the surf
 * wake — a strip of samples resolved into a mesh — and for the same reason: a swept
 * mesh gives a *continuous* arc where particles give a dotted line of it, and an arc
 * is what the eye follows.
 *
 * This is the second half of a problem the frost trail only half-solved. There is no
 * per-object motion blur here, so a metre of blade crossing 150 degrees in nine frames
 * has nothing joining up the poses it passes through; the powder grains marked where
 * the edge had been, and this draws the edge itself. They are deliberately both kept:
 * grains are matter thrown off the blade, the ribbon is light left behind it.
 *
 * The mesh is built once and only its positions are rewritten, because the interesting
 * attribute — where a vertex sits along the age of the trail — never changes. The ring
 * buffer is copied out in age order every frame, which is what lets `uv.x` be static
 * and the shader be a pure gradient.
 *
 * Allocation per frame: none.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3, Vector3 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { whenReady } from "../core/gpuUtil.js";

/**
 * Samples in the ribbon, and how long each survives.
 *
 * The longest strike in the combo is 0.34 s, and the ribbon has to outlast it or the
 * arc is clipped before the swing that made it has finished. Twenty-eight samples at
 * sixty frames a second is 0.46 s of buffer against a 0.34 s life, which leaves room
 * for a frame-rate dip without the head of the trail eating its own tail.
 */
const SAMPLES = 28;
const LIFE = 0.34;

/**
 * Where the blade's span sits inside the ribbon, 0 at the guard and 1 at the point.
 *
 * `INNER` is not the guard: a ribbon reaching the hilt sweeps a huge sheet of light
 * past the character's own body every swing, which reads as a cape. Just under halfway
 * keeps it to the fast outer blade, which is the only part travelling fast enough to
 * earn a contrail anyway — and keeps the ribbon *thin*, which a contrail has to be.
 * At a quarter of the way up it covered three quarters of a metre and read as a banner.
 * At 0.85 it is a 19 cm streak off the last few inches of the blade — which is what a
 * contrail is: something that comes off a *tip*, not a sheet dragged behind a wing.
 *
 * `MARGIN` is the feather, in metres of blade. The strip is built wider than the blade
 * on both sides so the shader has somewhere to fade *to* — an edge cannot be softened
 * at the boundary of the geometry, which is why the first version of this was a sharp
 * band no matter what the gradient did.
 */
const INNER = 0.85;
const MARGIN = 0.03;

/**
 * How far the point must move in a frame before the ribbon starts at all.
 *
 * Only a gate on *beginning* a trail, not on continuing one, and that distinction is
 * the whole fix for the trail appearing on some attacks and not others. Every strike
 * accelerates out of its coil — a fifth of the arc in the first half of the time — so
 * a per-sample speed gate rejected the entire opening of every swing, and on the
 * quick attacks, which are mostly opening, it rejected nearly all of them. Once a
 * strike is live every frame is sampled, and the ribbon's own geometry does the rest:
 * where the blade is slow, consecutive samples nearly coincide and there is almost no
 * ribbon to see. Speed shapes it for free, without a gate that can drop a whole swing.
 */
const MOVE_GATE = 0.02;

/** Vertices across the ribbon: inner feather, inner, outer, outer feather. */
const COLUMNS = 4;

/**
 * Interpolated stations between each pair of samples.
 *
 * This is the difference between a ribbon and a polyline, and it is not a matter of
 * adding triangles — it is a matter of having anything to put between the samples.
 *
 * A strike is sampled once a frame, and the sweep accelerates hard out of its coil, so
 * the fast part of a swing arrives as very few very long steps: the quick attack covers
 * 114 degrees in eleven frames with up to 17 degrees between consecutive samples. A
 * straight quad across 17 degrees of a one-metre arc misses the true path by more than
 * a centimetre, and six of them in a row is visibly a chain of flat panels — which is
 * exactly what it looked like.
 *
 * So the samples are treated as control points and the ribbon is built from a
 * Catmull-Rom spline through them, four stations per sample. Four is where the residual
 * chord error drops under a millimetre, which is smaller than the ribbon is wide.
 * Catmull-Rom because it passes *through* its control points: the ribbon has to touch
 * the positions the blade actually occupied, and a B-spline would smooth the arc away
 * from them.
 */
const SUBDIV = 4;

/** Stations along the finished ribbon. */
const STATIONS = (SAMPLES - 1) * SUBDIV + 1;

const _inner = new Vector3();
const _tip = new Vector3();
const _axis = new Vector3();
const _ci = new Vector3();
const _co = new Vector3();

export class SwordTrail {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {number} [seed] decorrelates the gold banding between players
     */
    constructor(scene, seed = 0) {
        this.scene = scene;
        this.seed = seed;

        /**
         * Ring buffer of control points: the inner and outer end of the blade span,
         * per sample. The feather points are no longer stored — they are derived per
         * *station* from the interpolated axis, because a margin computed at the
         * samples and then interpolated would cut the corners the spline rounds.
         */
        this._inner = new Float32Array(SAMPLES * 3);
        this._outer = new Float32Array(SAMPLES * 3);
        this._born = new Float32Array(SAMPLES);

        /** The live samples, gathered newest-first, as the spline's control points. */
        this._ctlInner = new Float32Array(SAMPLES * 3);
        this._ctlOuter = new Float32Array(SAMPLES * 3);
        this._head = 0;
        this._count = 0;
        this._t = 0;
        this._prevTip = new Vector3();
        this._hasPrev = false;

        /** Positions handed to the GPU, newest first. */
        this._verts = new Float32Array(STATIONS * COLUMNS * 3);

        this.mesh = buildMesh(scene, this._verts);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the wake and the spells: blended, drawn after the world is solid.
        this.mesh.renderingGroupId = 1;
        this.mesh.isVisible = false;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "swordTrail", this.scene, { vertex: "trail", fragment: "trail" },
            {
                attributes: ["position", "uv"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "trailTint", "trailGold", "trailIntensity", "trailSeed",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // Additive and depth-read-only. A trail is light added to whatever is behind
        // it: alpha blending would let it *darken* the snow where the ribbon is dim,
        // and writing depth would have each segment occlude the next one along.
        mat.alphaMode = Constants.ALPHA_ADD;
        mat.needAlphaBlending = () => true;
        mat.disableDepthWrite = true;
        mat.backFaceCulling = false;
        // Saturated, and that means an *extreme* channel ratio rather than a bright
        // pale blue.
        //
        // Additive light is added to snow that is already near the top of the range, so
        // whichever channels are high arrive at a pixel that has nothing left to give
        // and the result desaturates toward white. A pale blue — high red, high green,
        // high blue — therefore reads as white however carefully it is chosen. Holding
        // red down near a tenth is the only thing that keeps blue *blue* after the
        // tonemapper has compressed the top end.
        mat.setColor3("trailTint", new Color3(0.10, 0.46, 1.0));
        mat.setColor3("trailGold", new Color3(1.0, 0.74, 0.30));
        mat.setFloat("trailSeed", this.seed);
        return mat;
    }

    /**
     * Sample the blade, age the ribbon, and rebuild the strip.
     *
     * @param {number} dt
     * @param {import("../character/sword.js").IceSword} sword
     * @param {boolean} live whether the blade is in a strike — trails are only left by
     *   a swing, never by carrying the thing around
     */
    update(dt, sword, live) {
        this._t += dt;

        sword.tipPosition(_tip);
        const moved = this._hasPrev ? Vector3.Distance(_tip, this._prevTip) : 0;
        this._prevTip.copyFrom(_tip);
        this._hasPrev = true;

        // A teleport — a respawn, mostly — must not draw a ribbon across the map.
        if (moved > 6) {
            this.clear();
        } else if (live && (this._count > 0 || moved > MOVE_GATE)) {
            // Once a trail has started, every live frame is sampled. Only the *first*
            // sample has to clear the movement gate — see the note on `MOVE_GATE`.
            sword.bladePoint(INNER, _inner);
            this._writeSample(_inner, _tip);
        }

        this._build();
    }

    /**
     * Record one control point: where the blade's span was this frame.
     *
     * @param {Vector3} inner @param {Vector3} outer
     */
    _writeSample(inner, outer) {
        const o = this._head * 3;
        this._inner[o] = inner.x;
        this._inner[o + 1] = inner.y;
        this._inner[o + 2] = inner.z;
        this._outer[o] = outer.x;
        this._outer[o + 1] = outer.y;
        this._outer[o + 2] = outer.z;
        this._born[this._head] = this._t;
        this._head = (this._head + 1) % SAMPLES;
        if (this._count < SAMPLES) this._count++;
    }

    /**
     * Build the ribbon: gather the live control points, then walk a spline through them.
     *
     * The control points are gathered newest-first, which is what lets the age
     * coordinate stay a static vertex attribute — station *i* is always the same
     * fraction of the way back along the trail, so the shader's fade needs no per-frame
     * data. Stations past the end of the live range clamp onto the oldest point, which
     * collapses their triangles to zero area: they cost nothing and draw nothing, and
     * it is far simpler than resizing an index buffer every frame.
     */
    _build() {
        // Gather. Age increases monotonically walking back from the head, so the first
        // expired sample ends the run.
        let live = 0;
        for (let i = 0; i < SAMPLES && i < this._count; i++) {
            const slot = (this._head - 1 - i + SAMPLES * 2) % SAMPLES;
            if (this._t - this._born[slot] > LIFE) break;
            const src = slot * 3;
            const dst = live * 3;
            this._ctlInner[dst] = this._inner[src];
            this._ctlInner[dst + 1] = this._inner[src + 1];
            this._ctlInner[dst + 2] = this._inner[src + 2];
            this._ctlOuter[dst] = this._outer[src];
            this._ctlOuter[dst + 1] = this._outer[src + 1];
            this._ctlOuter[dst + 2] = this._outer[src + 2];
            live++;
        }

        const on = S.swordTrail === undefined ? 1 : S.swordTrail;
        this.mesh.isVisible = live >= 2 && S.showSword !== false && on > 0;
        if (!this.mesh.isVisible) return;

        const v = this._verts;
        const last = live - 1;
        for (let i = 0; i < STATIONS; i++) {
            // Station to sample space. Beyond the live range it clamps, and those
            // stations pile up on the oldest point.
            let u = (i / SUBDIV);
            if (u > last) u = last;
            const i0 = Math.floor(u);
            const f = u - i0;

            spline(this._ctlInner, live, i0, f, _ci);
            spline(this._ctlOuter, live, i0, f, _co);

            // The feather is derived here, from the *interpolated* axis, so the margin
            // follows the curve rather than the chords between samples.
            _axis.copyFrom(_co).subtractInPlace(_ci);
            const len = _axis.length();
            if (len > 1e-5) _axis.scaleInPlace(1 / len);
            else _axis.set(0, 1, 0);

            const d = i * COLUMNS * 3;
            v[d] = _ci.x - _axis.x * MARGIN;
            v[d + 1] = _ci.y - _axis.y * MARGIN;
            v[d + 2] = _ci.z - _axis.z * MARGIN;
            v[d + 3] = _ci.x;
            v[d + 4] = _ci.y;
            v[d + 5] = _ci.z;
            v[d + 6] = _co.x;
            v[d + 7] = _co.y;
            v[d + 8] = _co.z;
            v[d + 9] = _co.x + _axis.x * MARGIN;
            v[d + 10] = _co.y + _axis.y * MARGIN;
            v[d + 11] = _co.z + _axis.z * MARGIN;
        }

        this.mesh.updateVerticesData(VertexBuffer.PositionKind, v, false, false);
        this.material.setFloat("trailIntensity", on);
    }

    /** Drop the ribbon. Used on a teleport, and when the sword is put away. */
    clear() {
        this._count = 0;
        this._head = 0;
        this._hasPrev = false;
        this.mesh.isVisible = false;
    }

    /** @param {Vector3} cameraPos */
    sync(cameraPos) {
        if (this.mesh.isVisible) this.material.setVector3("cameraPos", cameraPos);
    }

    async warmUp() {
        const was = this.mesh.isVisible;
        this.mesh.isVisible = true;
        this.material.setFloat("trailIntensity", 1);
        await whenReady(this.material, "sword trail", [this.mesh, false]);
        this.mesh.isVisible = was;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
    }
}

/**
 * The strip: two vertices per sample, a quad between each neighbouring pair.
 *
 * `uv` is written once and never touched again — `uv.x` is age along the ribbon and
 * `uv.y` is across it — which is the whole reason the per-frame upload is positions
 * only.
 */
function buildMesh(scene, positions) {
    const uvs = new Float32Array(STATIONS * COLUMNS * 2);
    const idx = new Uint32Array((STATIONS - 1) * (COLUMNS - 1) * 6);

    // uv.y is the position across the *whole* strip, feather included, so the shader's
    // span constants and this table are two halves of one decision. 0 and 1 are the
    // outer feather edges and fade to nothing; the blade lives between them.
    const across = [0, 0.2, 0.8, 1];
    for (let i = 0; i < STATIONS; i++) {
        const t = i / (STATIONS - 1);
        for (let c = 0; c < COLUMNS; c++) {
            const o = (i * COLUMNS + c) * 2;
            uvs[o] = t;
            uvs[o + 1] = across[c];
        }
    }
    let w = 0;
    for (let i = 0; i < STATIONS - 1; i++) {
        for (let c = 0; c < COLUMNS - 1; c++) {
            const a = i * COLUMNS + c;
            const b = a + COLUMNS;
            idx[w++] = a; idx[w++] = a + 1; idx[w++] = b + 1;
            idx[w++] = a; idx[w++] = b + 1; idx[w++] = b;
        }
    }

    const mesh = new Mesh("swordTrail", scene);
    const vd = new VertexData();
    vd.positions = positions;
    vd.uvs = uvs;
    vd.indices = idx;
    // Updatable, because the positions are rewritten every frame.
    vd.applyToMesh(mesh, true);
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = {
        triangles: (STATIONS - 1) * (COLUMNS - 1) * 2,
        vertices: STATIONS * COLUMNS,
    };
    return mesh;
}

/**
 * Catmull-Rom through a flat array of points, into `out`.
 *
 * Chosen over a B-spline because it interpolates its control points rather than
 * approximating them: the ribbon has to pass through the positions the blade actually
 * occupied, and smoothing the arc away from them would put the light somewhere the edge
 * never was. The ends clamp their missing neighbour onto themselves, which makes the
 * first and last segments a plain curve rather than shooting off toward a phantom
 * point.
 *
 * @param {Float32Array} p three floats per point
 * @param {number} n how many points are live
 * @param {number} i index of the segment's start point
 * @param {number} t 0..1 within that segment
 * @param {Vector3} out
 */
function spline(p, n, i, t, out) {
    const i0 = Math.max(0, i - 1) * 3;
    const i1 = i * 3;
    const i2 = Math.min(n - 1, i + 1) * 3;
    const i3 = Math.min(n - 1, i + 2) * 3;
    const t2 = t * t;
    const t3 = t2 * t;

    for (let k = 0; k < 3; k++) {
        const a = p[i0 + k];
        const b = p[i1 + k];
        const c = p[i2 + k];
        const d = p[i3 + k];
        const v = 0.5 * (
            2 * b +
            (c - a) * t +
            (2 * a - 5 * b + 4 * c - d) * t2 +
            (-a + 3 * b - 3 * c + d) * t3
        );
        if (k === 0) out.x = v;
        else if (k === 1) out.y = v;
        else out.z = v;
    }
}
