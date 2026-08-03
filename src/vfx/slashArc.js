/**
 * The slash arc.
 *
 * A broad crescent of light covering the whole surface the blade swept, with a white-hot
 * middle, a deep blue rim, filaments running its length and dark lenses inside it. It is
 * a *different effect* from `SwordTrail`, not a replacement: the trail is a thin contrail
 * hugging the last hand's-width of the edge, and this is the sheet. Both run, and either
 * can be turned off — `S.swordTrail` and `S.slashArc`.
 *
 * The lifecycle is what separates it from the trail. A contrail is a rolling window: the
 * oldest sample expires while the newest arrives. An arc is one gesture — it grows while
 * the blade is live, then the whole thing is frozen where it was and fades out together.
 * Freezing rather than continuing to follow the blade matters, because the blade is
 * already retracting by then and a sheet that followed it would fold back through itself.
 *
 * Snow comes off the outer rim while it grows. The reference art has powder curling off
 * the ends of every arc, and the blade is travelling through a snowfield at ten metres a
 * second, so the grains are the one part of this that is not stylisation.
 *
 * Allocation per frame: none. One mesh per player, its vertex buffer rewritten in place.
 */

import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";

import { S } from "../core/settings.js";
import {
    ARC_SAMPLES, ARC_STATIONS, ARC_COLUMNS,
    buildArcVertices, buildArcUVs, buildArcIndices,
} from "./arcMesh.js";

/**
 * How long the frozen arc takes to go out, seconds.
 *
 * Longer than the trail's 0.34 s window because this is a single flash rather than a
 * rolling one: it has to survive being looked at after the swing has finished, which is
 * when a player actually reads what happened.
 */
const FADE = 0.28;

/**
 * Minimum blade travel before a sample is recorded, metres.
 *
 * Gates *recording*, not drawing. Without it a stationary blade records the same point
 * twenty-two times and the spline through them is a degenerate sheet of zero area, which
 * is harmless but wastes the whole buffer on nothing.
 */
const STEP_GATE = 0.015;

/** Snow grains thrown per second while the arc is growing. */
const GRAINS_PER_SEC = 90;

const _in = new Vector3();
const _out = new Vector3();
const _prev = new Vector3();
const _travel = new Vector3();

export class SlashArc {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {{ emit: Function }|null} [spray] the shared grain pool
     */
    constructor(scene, spray) {
        this.scene = scene;
        this.spray = spray || null;

        /** Control points, newest first, three floats each. */
        this._inner = new Float32Array(ARC_SAMPLES * 3);
        this._outer = new Float32Array(ARC_SAMPLES * 3);
        this._count = 0;

        this._verts = new Float32Array(ARC_STATIONS * ARC_COLUMNS * 3);
        this._live = false;
        this._fade = 0;
        this._hasPrev = false;
        this._grainDebt = 0;
        /** Shifts the striations per swing, so consecutive arcs are not stamped alike. */
        this.seed = Math.random();

        this.mesh = this._buildMesh();
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the trail, the wake and the spells: blended, after the world is solid.
        this.mesh.renderingGroupId = 1;
        this.mesh.isVisible = false;
    }

    _buildMesh() {
        const uvs = new Float32Array(ARC_STATIONS * ARC_COLUMNS * 2);
        const idx = new Uint32Array((ARC_STATIONS - 1) * (ARC_COLUMNS - 1) * 6);
        buildArcUVs(uvs);
        buildArcIndices(idx);

        const mesh = new Mesh("slashArc", this.scene);
        const vd = new VertexData();
        vd.positions = this._verts;
        vd.uvs = uvs;
        vd.indices = idx;
        // Updatable: the positions are rewritten every frame and the topology never is.
        vd.applyToMesh(mesh, true);
        // The sheet moves with the swing and its vertices are world space already, so any
        // bounding volume computed from them is stale the frame after. Cheaper and more
        // correct to stop the culler having an opinion.
        mesh.alwaysSelectAsActiveMesh = true;
        mesh.isPickable = false;
        mesh.doNotSyncBoundingInfo = true;
        return mesh;
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "slashArc", this.scene, { vertex: "slash", fragment: "slash" },
            {
                attributes: ["position", "uv"],
                uniforms: [
                    "viewProjection", "cameraPos",
                    "slashCore", "slashRim", "slashIntensity", "slashFade", "slashSeed",
                ],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // Additive, depth-read-only. The same reasoning as the trail: this is light added
        // to what is behind it, so alpha blending would let a dim part of the sheet
        // *darken* the snow, and writing depth would have each station occlude the next.
        mat.alphaMode = Constants.ALPHA_ADD;
        mat.needAlphaBlending = () => true;
        mat.disableDepthWrite = true;
        mat.backFaceCulling = false;

        // The core is not pure white. Additive light over bright snow desaturates on its
        // own, so a core of exactly (1,1,1) arrives washed out and takes the rim with it;
        // holding a little blue in it is what leaves the sheet reading as ice rather than
        // as an overexposed photograph.
        mat.setColor3("slashCore", new Color3(0.88, 0.96, 1.0));
        // Boldness lives here rather than in the shader's arithmetic, so it is one number
        // to turn. The sheet is the *body* of the effect — the reference art is mostly
        // sheet — and at the original scale it was a hint of one.
        // The rim is the same extreme channel ratio the trail uses, and for the same
        // reason: red held near a tenth is the only thing that keeps blue blue after the
        // tonemapper has compressed the top end.
        mat.setColor3("slashRim", new Color3(0.09, 0.42, 1.0));
        mat.setFloat("slashSeed", this.seed);
        mat.setFloat("slashFade", 0);
        mat.setFloat("slashIntensity", 1);
        return mat;
    }

    /**
     * @param {number} dt
     * @param {import("../character/sword.js").IceSword} sword
     * @param {boolean} live true while the blade is inside its strike window — the same
     *   window the hit resolver uses, so what throws light and what can hurt you are the
     *   same thing
     */
    update(dt, sword, live) {
        const intensity = S.slashArc === undefined ? 1 : S.slashArc;
        if (intensity <= 0) {
            this.mesh.isVisible = false;
            this._live = false;
            this._count = 0;
            return;
        }

        sword.bladePoint(0, _in);
        sword.tipPosition(_out);

        if (live) {
            if (!this._live) {
                // A new swing. The buffer is dropped rather than continued, because an arc
                // is one gesture and joining two would draw a sheet through the space
                // between them.
                this._live = true;
                this._count = 0;
                this._hasPrev = false;
                this._fade = 1;
                this._grainDebt = 0;
                this.seed = Math.random();
                this.material.setFloat("slashSeed", this.seed);
            }

            const moved = this._hasPrev ? Vector3.Distance(_out, _prev) : Infinity;
            if (moved >= STEP_GATE) {
                this._push(_in, _out);
                // The direction of travel, captured *before* `_prev` is advanced. Reading
                // it afterwards gives the difference between a vector and itself — zero —
                // so every grain left the blade with no directional velocity at all. The
                // same aliasing that had the swept blade testing a zero-length segment.
                _travel.copyFrom(_out).subtractInPlace(_prev);
                _prev.copyFrom(_out);
                this._hasPrev = true;
                this._throwSnow(dt, moved);
            }
        } else if (this._live) {
            // The strike closed. Freeze where it is and start the fade — the blade is
            // already retracting, and a sheet that kept following it would fold back
            // through itself.
            this._live = false;
        }

        if (this._live) {
            this._fade = 1;
        } else if (this._fade > 0) {
            this._fade = Math.max(0, this._fade - dt / FADE);
        }

        if (this._fade <= 0 || this._count < 2) {
            this.mesh.isVisible = false;
            return;
        }

        // Rebuilt every frame even while frozen, because the geometry is world space and
        // the *player* may still be moving: a sheet left in world coordinates would slide
        // out from under a running character. Rebuilding from unchanged control points is
        // the same cost and is always right.
        buildArcVertices(this._inner, this._outer, this._count, this._verts);
        this.mesh.updateVerticesData("position", this._verts, false, false);

        // Squared, so the arc holds its brightness and then goes rather than dimming
        // evenly across the whole fade. An even fade reads as a decal being turned down.
        this.material.setFloat("slashFade", this._fade * this._fade);
        this.material.setFloat("slashIntensity", intensity);
        this.mesh.isVisible = true;
    }

    /** Newest first, oldest pushed off the end. */
    _push(inner, outer) {
        const n = Math.min(this._count + 1, ARC_SAMPLES);
        // Shifted rather than held in a ring with a moving head, because the spline walks
        // these in order and an index that wraps would need the wrap handled in the
        // interpolator too — which is where an off-by-one would be least visible and most
        // annoying.
        for (let i = n - 1; i > 0; i--) {
            const d = i * 3;
            const s = (i - 1) * 3;
            this._inner[d] = this._inner[s];
            this._inner[d + 1] = this._inner[s + 1];
            this._inner[d + 2] = this._inner[s + 2];
            this._outer[d] = this._outer[s];
            this._outer[d + 1] = this._outer[s + 1];
            this._outer[d + 2] = this._outer[s + 2];
        }
        this._inner[0] = inner.x;
        this._inner[1] = inner.y;
        this._inner[2] = inner.z;
        this._outer[0] = outer.x;
        this._outer[1] = outer.y;
        this._outer[2] = outer.z;
        this._count = n;
    }

    /**
     * Powder off the outer rim.
     *
     * Thrown along the blade's own travel with a wide spread, from a point a little past
     * the tip — which is where the sheet's bright edge is, not where the blade is. The
     * grains are the only part of this effect that is not stylisation: the point is moving
     * through a snowfield at ten metres a second.
     *
     * The debt accumulator keeps the rate in grains per *second* rather than per frame, so
     * a slow frame does not thin the powder out.
     */
    _throwSnow(dt, moved) {
        const sp = this.spray;
        if (!sp || S.showSpray === false) return;
        this._grainDebt += GRAINS_PER_SEC * dt;
        let n = Math.floor(this._grainDebt);
        if (n <= 0) return;
        this._grainDebt -= n;
        if (n > 12) n = 12;

        // Direction of travel, captured before `_prev` moved — see `update`.
        const tx = _travel.x;
        const ty = _travel.y;
        const tz = _travel.z;
        const tl = Math.hypot(tx, ty, tz) || 1;
        const speed = moved / Math.max(dt, 1e-4);

        for (let i = 0; i < n; i++) {
            // Along the sheet's outer third, so the powder traces the bright edge.
            const k = 0.72 + Math.random() * 0.5;
            const px = _in.x + (_out.x - _in.x) * k;
            const py = _in.y + (_out.y - _in.y) * k;
            const pz = _in.z + (_out.z - _in.z) * k;

            // Mostly forward with the blade, plus a cone. Fully random directions read as
            // an explosion; biased along the travel reads as material being dragged.
            const spread = 1.5;
            const v = speed * (0.18 + Math.random() * 0.3);
            sp.emit(
                px, py, pz,
                (tx / tl) * v + (Math.random() - 0.5) * spread,
                (ty / tl) * v + Math.random() * spread * 0.8,
                (tz / tl) * v + (Math.random() - 0.5) * spread,
                0.016 + Math.random() * 0.026,
                0.28 + Math.random() * 0.4,
                0,
                2.6
            );
        }
    }

    get triangles() {
        return this.mesh.isVisible ? (ARC_STATIONS - 1) * (ARC_COLUMNS - 1) * 2 : 0;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
    }
}
