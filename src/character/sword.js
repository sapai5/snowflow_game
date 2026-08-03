/**
 * The ice sword.
 *
 * A 443-triangle jagged crystal blade in the character's right hand, carried by
 * one rigid matrix per frame: the hand bone's skinning frame times a fixed grip
 * offset. Nothing is skinned, nothing is generated at runtime, and the mesh's own
 * world matrix stays frozen at the identity — the transform lives in a uniform,
 * which is both cheaper than a scene-graph parent and exactly as accurate.
 *
 * The silhouette is a converted CC0 asset — see `swordMesh.js` for provenance and
 * for what the conversion derived. Ice and gold, in one draw: the shards and
 * the grip body are ice, the guard band and the set gem are gold, and the blade
 * still carries the engraved gold inlay, which costs no geometry at all. The
 * part id rides in a vertex attribute and the fragment shader branches on it.
 *
 * Sword space is unchanged: pommel at the origin, blade running up +Y, the guard
 * at 0.215 m and the point at 1.075 m, so the grip transform, the fist pivot and
 * `bladePoint` all survived the swap untouched.
 *
 * Allocation per frame: none.
 */

import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { ShaderLanguage } from "@babylonjs/core/Materials/shaderLanguage";
import { Constants } from "@babylonjs/core/Engines/constants";
import { Matrix, Vector3, Vector4 } from "@babylonjs/core/Maths/math";

import { S } from "../core/settings.js";
import { whenReady, bindMatrixArray } from "../core/gpuUtil.js";
import { expDamp } from "../core/camera.js";
import { CASCADE_COUNT } from "../render/shadows.js";
import { SPELL_LIGHT_UNIFORMS } from "../spells/spellLights.js";
import { B_HAND_R } from "./figure.js";
import { mul } from "../core/mat4.js";
import {
    SWORD_POS, SWORD_UV, SWORD_AUX, SWORD_IDX, SWORD_TRIS, SWORD_VERTS,
} from "./swordMesh.js";

// ------------------------------------------------------------------ geometry
//
// A hand-and-a-half blade, deliberately oversized: the camera sits three and a
// half metres back over the shoulder, and at that framing a realistically
// proportioned sword is a grey line. Everything here is scaled to read.
//
/** Grip runs from the pommel to the guard. */
const GRIP_TOP = 0.165;
/** Guard collar, where the gold band sits. */
const GUARD_TOP = 0.215;
/** Blade length, guard to point. */
const BLADE_LEN = 0.86;
// --------------------------------------------------------------------- grip
/**
 * Where the fist closes, in the *hand bone's* frame, metres.
 *
 * Measured off the mitt: `build.js` lofts it from four rings, and transformed into
 * the bone's own basis their centres sit at x -0.001, z +0.003 — the mitt is
 * essentially on-axis, and the forward drift it appears to have in world space is
 * just the bone direction leaning. y 0.045 is between the first and third rings,
 * which is the middle of the closed hand.
 */
const HAND_X = -0.001;
const HAND_Y = 0.045;
const HAND_Z = 0.003;
/**
 * Tilt away from the body, radians. A blade hanging dead in line with the arm
 * goes through the thigh and then through the robe, and no amount of shading
 * saves a sword that is inside a leg.
 */
const TILT_OUT = 0.34;
/**
 * Tilt forward, radians — and the reason it is this large is arithmetic, not
 * taste. The hand hangs about 0.97 m off the snow and the sword is 1.08 m from
 * pommel to point, so a blade carried anywhere near vertical is in the ground.
 * At 33 degrees the drop is 0.90 m and the point rides a hand's width clear,
 * which also happens to be the angle a person actually walks with a drawn blade.
 */
const TILT_FWD = 0.58;
/**
 * Extra tilt at a full run, radians, on each axis.
 *
 * The hand drops and swings as the gait picks up, and a metre of blade multiplies
 * every centimetre of that at the point. Rather than fight the arm, the carry
 * changes: the blade comes up and out as the character speeds up, the way anyone
 * running with something long in one hand raises it. Forward tilt buys clearance
 * from the snow, outward tilt buys clearance from the leg.
 */
const RUN_TILT_FWD = 0.30;
const RUN_TILT_OUT = 0.10;
/** Speed at which the running carry is fully in, m/s. */
const RUN_TILT_SPEED = 5.0;

/** Stand-in for the controller during warm-up, where nothing is moving yet. */
const STANDING = { speed: 0, swingBlend: 0 };

// ------------------------------------------------------------------- whip
/**
 * The blade does not go exactly where the hand puts it.
 *
 * A metre of ice on the end of a wrist has its own inertia: it trails the hand
 * into a swing, whips past it when the hand slows, and rings for a moment
 * afterwards. Nothing about a rigid grip can produce that, and its absence is
 * most of why a procedural swing reads as a stick being pointed rather than a
 * weapon being swung.
 *
 * So the blade's direction is a spring chasing the direction the grip says it
 * should have. Steady state under a fast swing sits around 25 degrees of trail,
 * which is roughly what a real blade does; the underdamped ratio is what produces
 * the whip on the way out and the settle at the end. This costs one spring
 * integration per frame and it is the single largest change to how the sword
 * feels.
 */
const WHIP_STIFF = 2600;
const WHIP_DAMP = 46;
/** Hard limit on the deviation, radians. Past this it stops looking like a sword. */
const WHIP_MAX = 0.50;
/** Height up the hilt the fist closes, metres — the point the blade pivots about. */
const FIST_Y = 0.085;

/** Must match `HITSTOP_RATE` in `swordCombat.js`. */
const HITSTOP_RATE = 0.35;

const _ideal = new Vector3();
const _pivot = new Vector3();
const _axis = new Vector3();
const _capA = new Vector3();
const _capB = new Vector3();

export class IceSword {
    /**
     * @param {import("@babylonjs/core/scene").Scene} scene
     * @param {import("../render/sky.js").Sky} sky
     * @param {import("../render/shadows.js").ShadowSystem} shadows
     * @param {import("./figure.js").Figure} figure posed skeleton
     */
    constructor(scene, sky, shadows, figure) {
        this.scene = scene;
        this.sky = sky;
        this.shadows = shadows;
        this.figure = figure;

        this.mesh = buildMesh(scene);
        this.material = this._makeMaterial();
        this.mesh.material = this.material;
        // With the character and the crystals, and for the same reason: it is
        // blended against the field but it is not a particle.
        this.mesh.renderingGroupId = 1;

        this.triangles = this.mesh.metadata.triangles;

        /**
         * Hand bone frame times the grip offset, rebuilt every frame. Kept as a
         * raw 16-float array because `mat4.mul` writes into one and the Babylon
         * `Matrix` is only needed at the point of upload.
         */
        this._world = new Float32Array(16);
        this._matrix = Matrix.Identity();
        this._grip = new Float32Array(16);
        /** 0..1 eased blend into the running carry. */
        this._carry = 0;
        writeGrip(this._grip, 0, 1);

        this._cameraPos = new Vector3();
        this._splits = new Vector4(0, 0, 0, 0);
        this._t = 0;

        /** Where the blade actually points, as opposed to where the grip says. */
        this._blade = new Vector3(0, 1, 0);
        this._bladeVel = new Vector3(0, 0, 0);
        this._bladeInit = false;

        this.setVisible(S.showSword !== false && S.showCharacter !== false);
    }

    _makeMaterial() {
        const mat = new ShaderMaterial(
            "iceSword", this.scene, { vertex: "sword", fragment: "sword" },
            {
                attributes: ["position", "uv", "aux"],
                uniforms: [
                    "viewProjection", "swordWorld", "cameraPos",
                    "sunDir", "sunRadiance", "shR",
                    "cascadeMatrices", "cascadeSplits", "cascadeParams",
                    "shadowTexel", "shadowSoftness", "shadowBias",
                    "fogDensity", "fogHeightFalloff", "fogStart", "aerialStrength",
                    "ambientIntensity", "sssStrength",
                    "swordGlow", "swordTime",
                    ...SPELL_LIGHT_UNIFORMS,
                ],
                samplers: ["skyLUT", "cascade0", "cascade1", "cascade2"],
                shaderLanguage: ShaderLanguage.WGSL,
                needAlphaBlending: true,
            }
        );
        // The blade is a closed solid, but its facets are thin and its winding is
        // not worth trusting at this triangle count — the fragment shader turns
        // the normal toward the viewer anyway.
        mat.backFaceCulling = false;
        // Blended *and* depth-writing. See `crystal.fragment.wgsl`: this is what
        // gives transparency against the snow without the blade blending over
        // itself where the guard crosses it.
        mat.alphaMode = Constants.ALPHA_COMBINE;
        mat.needAlphaBlending = () => true;
        mat.disableDepthWrite = false;
        mat.forceDepthWrite = true;
        mat.setTexture("skyLUT", this.sky.lut);
        for (let i = 0; i < CASCADE_COUNT; i++) {
            mat.setTexture("cascade" + i, this.shadows.maps[i]);
        }
        return mat;
    }

    /**
     * The camera-space depth prepass.
     *
     * The blade is registered and the shadow cascades are not, on purpose. It
     * writes the specular mask the reflection pass gates on, which is worth one
     * two-hundred-triangle draw; the shadow it would cast is a sliver inside the
     * character's own, at a filter width an order of magnitude wider than the
     * blade is thick.
     *
     * @param {import("../render/depthPass.js").DepthPass} depth
     */
    registerPrepass(depth) {
        const mat = new ShaderMaterial(
            "swordPrepass", this.scene,
            { vertex: "swordPrepass", fragment: "prepass" },
            {
                attributes: ["position"],
                uniforms: ["viewProjection", "swordWorld"],
                shaderLanguage: ShaderLanguage.WGSL,
            }
        );
        mat.backFaceCulling = false;
        this.prepassMat = mat;
        depth.registerCaster(this.mesh, mat);
    }

    setVisible(v) {
        this.mesh.isVisible = !!v;
    }

    /**
     * Follow the hand.
     *
     * Called after the figure has been posed and before anything reads the
     * transform, which is the same slot the garments occupy: the hand frame this
     * multiplies is this frame's, not last frame's, and a sword one frame behind
     * the fist holding it is visible at a walk and comical at a carve.
     *
     * The grip offset is rebuilt each frame rather than baked, because the carry
     * angle eases with speed — see `RUN_TILT_FWD`. It is nine multiplies.
     *
     * @param {number} dt
     * @param {import("./controller.js").CharacterController} ch
     */
    update(dt, ch) {
        this._t += dt;

        // Eased, and slowly: the carry is a decision the character makes, not a
        // reading off the speedometer. Anything faster than this and the blade
        // visibly twitches every time the player taps a movement key.
        const want = Math.min(1, ch.speed / RUN_TILT_SPEED);
        this._carry = expDamp(this._carry, want, 2.4, Math.min(dt, 1 / 30));
        // Mid-swing the carry angles collapse: the blade comes into line with the
        // forearm, which is how a sword is actually swung and what makes the arc
        // read as an edge travelling rather than as a stick being waved. The
        // combo's own blend does the easing, so this can be a straight multiply.
        writeGrip(this._grip, this._carry, 1 - 0.92 * ch.swingBlend);

        mul(this._world, 0, this.figure.world, B_HAND_R * 16, this._grip, 0);
        this._whip(dt, ch);
        Matrix.FromArrayToRef(this._world, 0, this._matrix);
    }

    /**
     * Let the blade lag the hand, then whip past it.
     *
     * Three substeps, because the spring is stiff enough that a single 1/30 s step
     * sits at the stability limit of a semi-implicit integrator, and the failure
     * mode of exceeding it is the sword becoming a propeller. Three multiplies is
     * a cheap price for never having to think about that again.
     *
     * @param {number} dt
     * @param {{hitstop?: number}} ch the controller, for the hit-stop flag
     */
    _whip(dt, ch) {
        const m = this._world;
        // The direction the grip says the blade points, and the point it pivots
        // about — the middle of the fist, not the sword's origin, so the hilt stays
        // in the hand while the blade moves around it.
        _ideal.set(m[4], m[5], m[6]);
        _pivot.set(
            m[4] * FIST_Y + m[12],
            m[5] * FIST_Y + m[13],
            m[6] * FIST_Y + m[14]
        );

        if (!this._bladeInit) {
            this._blade.copyFrom(_ideal);
            this._bladeInit = true;
            return;
        }

        // Hit-stop: the blade drops into the same slow motion as the body rather
        // than stopping in it. It is the most visible moving thing on the
        // character, so a freeze here is the one the eye actually catches.
        const h = Math.min(dt, 1 / 30) / 3 * ((ch.hitstop || 0) > 0 ? HITSTOP_RATE : 1);
        for (let i = 0; i < 3; i++) {
            springVec(this._blade, this._bladeVel, _ideal, WHIP_STIFF, WHIP_DAMP, h);
        }
        this._blade.normalize();

        // The rotation that takes the grip's answer to the blade's own.
        Vector3.CrossToRef(_ideal, this._blade, _axis);
        const sin = _axis.length();
        if (sin < 1e-5) return;
        _axis.scaleInPlace(1 / sin);
        let angle = Math.atan2(sin, Math.max(-1, Math.min(1, Vector3.Dot(_ideal, this._blade))));

        if (angle > WHIP_MAX) {
            // Pull the state back to the limit as well as clamping the output, so
            // the spring cannot wander further out and sit there.
            angle = WHIP_MAX;
            rotateAbout(_ideal, _axis, angle, this._blade);
        }

        rotateFrame(m, _pivot.x, _pivot.y, _pivot.z, _axis.x, _axis.y, _axis.z, angle);
    }

    /**
     * World position of the point, for anything that needs to know where the
     * blade actually is — the snow it cuts, mainly.
     *
     * @param {Vector3} out
     */
    tipPosition(out) {
        return this.bladePoint(1, out);
    }

    /**
     * A point along the blade. `t` runs 0 at the guard to 1 at the point.
     *
     * The blade lies along the sword's local +Y, so this is one column of the
     * transform scaled and added to its translation — no matrix multiply.
     *
     * @param {number} t
     * @param {Vector3} out
     */
    bladePoint(t, out) {
        const m = this._world;
        const y = GUARD_TOP + BLADE_LEN * t;
        out.set(
            m[4] * y + m[12],
            m[5] * y + m[13],
            m[6] * y + m[14]
        );
        return out;
    }

    /**
     * Ring the blade.
     *
     * Injects angular velocity straight into the whip spring, which is exactly what a
     * blade meeting another blade does: the hilt stays in the hand and the length of
     * it recoils and rings. Reusing the spring rather than playing a recoil animation
     * means a parry looks like the swing it interrupted, in the plane it was
     * travelling in, for free.
     *
     * @param {number} strength radians per second, roughly
     */
    kick(strength) {
        // Perpendicular to the blade, in the plane the swing was sweeping, so the
        // recoil opposes the motion rather than twisting the sword about its own axis.
        const m = this._world;
        this._bladeVel.x += m[0] * strength;
        this._bladeVel.y += m[1] * strength;
        this._bladeVel.z += m[2] * strength;
    }

    /**
     * Hand this frame's collision capsule to the cloth solver.
     *
     * Deliberately *not* the whole sword: the capsule starts at the guard and runs
     * a third of the way up the blade. The pommel and the grip are left out of it,
     * so the robe is allowed to settle over the top of the hilt — a hand's width of
     * fabric lying across the pommel is exactly how a sword carried at the hip
     * sits under a long coat, and colliding the full hilt was what kept the cloth
     * hovering a radius away from it instead. The blade section still pushes, so
     * the hem never slices through the flat during a turn.
     *
     * One frame stale by construction (the solver runs before the sword is
     * posed), which on a hanging robe is invisible.
     *
     * @param {import("./cloth.js").ClothSolver} solver
     */
    feedCloth(solver) {
        this.bladePoint(0, _capA);
        this.bladePoint(0.33, _capB);
        solver.setSwordCapsule(
            _capA.x, _capA.y, _capA.z,
            _capB.x, _capB.y, _capB.z,
            0.05
        );
    }

    /**
     * Push this frame's uniforms. Split from `update` for the reason spelled out
     * on `Character.sync`: the cascades have to have been refitted first, or the
     * blade shades against last frame's shadow matrices.
     *
     * @param {Vector3} cameraPos
     */
    sync(cameraPos) {
        if (!this.mesh.isVisible) return;
        this._cameraPos.copyFrom(cameraPos);

        const m = this.material;
        const sky = this.sky;
        const sh = this.shadows;

        m.setMatrix("swordWorld", this._matrix);
        m.setVector3("cameraPos", this._cameraPos);
        m.setVector3("sunDir", sky.sunDir);
        m.setColor3("sunRadiance", sky.sunRadiance);
        m.setArray4("shR", sky.sh);

        bindMatrixArray(m, "cascadeMatrices", sh.matrixData);
        this._splits.set(sh.splits[0], sh.splits[1], sh.splits[2], sh.splits[3]);
        m.setVector4("cascadeSplits", this._splits);
        m.setArray4("cascadeParams", sh.paramData);
        m.setFloat("shadowTexel", sh.texelSize);
        m.setFloat("shadowSoftness", 1.3);
        m.setFloat("shadowBias", 0.012);

        m.setFloat("fogDensity", S.fogDensity);
        m.setFloat("fogHeightFalloff", S.fogHeightFalloff);
        m.setFloat("fogStart", S.fogStart);
        m.setFloat("aerialStrength", S.aerialStrength);
        m.setFloat("ambientIntensity", S.ambientIntensity);
        m.setFloat("sssStrength", S.sssStrength);
        m.setFloat("swordGlow", S.swordGlow);
        m.setFloat("swordTime", this._t);

        if (this.prepassMat) this.prepassMat.setMatrix("swordWorld", this._matrix);
    }

    /** Compile both pipelines behind the loading screen. */
    async warmUp() {
        const wasVisible = this.mesh.isVisible;
        this.mesh.isVisible = true;
        this.update(0, STANDING);
        this.sync(this._cameraPos);

        await whenReady(this.material, "sword material", [this.mesh, false]);
        if (this.prepassMat) {
            await whenReady(this.prepassMat, "sword prepass", [this.mesh, false]);
        }
        this.mesh.isVisible = wasVisible;
    }

    dispose() {
        this.mesh.dispose();
        this.material.dispose();
        this.prepassMat?.dispose();
    }
}

/**
 * Semi-implicit damped spring on a direction vector.
 *
 * Not normalised here — the caller does that after the last substep, because
 * renormalising inside the integrator quietly removes energy and the overshoot is
 * the whole point of using a spring.
 */
function springVec(pos, vel, target, k, c, h) {
    vel.x += (k * (target.x - pos.x) - c * vel.x) * h;
    vel.y += (k * (target.y - pos.y) - c * vel.y) * h;
    vel.z += (k * (target.z - pos.z) - c * vel.z) * h;
    pos.x += vel.x * h;
    pos.y += vel.y * h;
    pos.z += vel.z * h;
}

/** Rodrigues on one vector, into `out`. */
function rotateAbout(v, axis, angle, out) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;
    const d = axis.x * v.x + axis.y * v.y + axis.z * v.z;
    out.set(
        v.x * c + (axis.y * v.z - axis.z * v.y) * s + axis.x * d * t,
        v.y * c + (axis.z * v.x - axis.x * v.z) * s + axis.y * d * t,
        v.z * c + (axis.x * v.y - axis.y * v.x) * s + axis.z * d * t
    );
}

/**
 * Rotate a rigid 4x4 in place about a world axis through a pivot.
 *
 * Rodrigues on the three basis columns and on the offset from the pivot, which
 * for a rigid frame is the whole transform. The same operation the figure applies
 * to a whole skeleton for the somersault, on one matrix.
 */
function rotateFrame(m, px, py, pz, ax, ay, az, angle) {
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const t = 1 - c;

    for (let col = 0; col < 3; col++) {
        const i = col * 4;
        const x = m[i], y = m[i + 1], z = m[i + 2];
        const d = ax * x + ay * y + az * z;
        m[i] = x * c + (ay * z - az * y) * s + ax * d * t;
        m[i + 1] = y * c + (az * x - ax * z) * s + ay * d * t;
        m[i + 2] = z * c + (ax * y - ay * x) * s + az * d * t;
    }

    const x = m[12] - px, y = m[13] - py, z = m[14] - pz;
    const d = ax * x + ay * y + az * z;
    m[12] = px + x * c + (ay * z - az * y) * s + ax * d * t;
    m[13] = py + y * c + (az * x - ax * z) * s + ay * d * t;
    m[14] = pz + z * c + (ax * y - ay * x) * s + az * d * t;
}

/**
 * The hand-to-sword transform, column-major, as the shader multiplies it:
 * `world * position`. Written in place, every frame, because the carry angle
 * eases with speed.
 *
 * The construction is `T(hand) · R · T(-fist)`: rotate the sword about the point
 * on its *own hilt* that the fist closes around, then put that point in the hand.
 *
 * That ordering is the whole fix for the sword floating. Rotating about the sword's
 * origin — the pommel — swings everything above it away by the tilt angle times the
 * distance, and at a 33-degree carry the hilt ended up 7.5 cm in front of the bone
 * axis. Front-on, that is a sword hanging in mid-air beside a closed hand. Anchored
 * at the fist instead, the grip is *always* in the hand: the tilts, the speed-driven
 * carry and the swing's grip-flattening can all be retuned freely and they only
 * ever pivot the blade within the fist, which is what a wrist does.
 *
 * The angles are written out rather than composed from library rotations because
 * the sign of each has a meaning — outward is *away from the thigh*, in the hand's
 * own basis where +Y runs down the arm and +Z is the body's forward.
 * `R · (0,1,0)` comes out as `(-sin(out)cos(fwd), cos(out)cos(fwd), sin(fwd))`: a
 * positive `TILT_OUT` swings the point toward local -X, which for the right hand is
 * away from the body, and a positive `TILT_FWD` swings it forward.
 *
 * @param {Float32Array} m 16 floats, overwritten
 * @param {number} carry 0 = standing carry, 1 = running carry
 * @param {number} scale multiplies both tilts — 0 puts the blade in line with
 *   the forearm, which is the swinging grip
 */
function writeGrip(m, carry, scale) {
    const out = (TILT_OUT + RUN_TILT_OUT * carry) * scale;
    const fwd = (TILT_FWD + RUN_TILT_FWD * carry) * scale;
    const c = Math.cos(out);
    const s = Math.sin(out);
    const cf = Math.cos(fwd);
    const sf = Math.sin(fwd);

    // Column 0: the blade's width axis.
    m[0] = c; m[1] = s; m[2] = 0; m[3] = 0;
    // Column 1: along the blade.
    m[4] = -s * cf; m[5] = c * cf; m[6] = sf; m[7] = 0;
    // Column 2: the blade's thickness axis.
    m[8] = s * sf; m[9] = -c * sf; m[10] = cf; m[11] = 0;
    // Translation: put the hilt's fist point exactly at the hand's fist point.
    m[12] = HAND_X - m[4] * FIST_Y;
    m[13] = HAND_Y - m[5] * FIST_Y;
    m[14] = HAND_Z - m[6] * FIST_Y;
    m[15] = 1;
}

/**
 * Build the sword from the converted asset in `swordMesh.js`.
 *
 * Two materials, one mesh, exactly as before — the difference is that the
 * silhouette is now the Swordtember "Crystal" blade: a jagged shard of ice with
 * a gold band and a set gem at the guard, both of which the converter mapped to
 * the gold material. The transform is a uniform, so the mesh itself never
 * moves and never needs to be culled against anything.
 */
function buildMesh(scene) {
    const mesh = new Mesh("iceSword", scene);
    const vd = new VertexData();
    vd.positions = SWORD_POS;
    vd.uvs = SWORD_UV;
    vd.indices = SWORD_IDX;
    vd.applyToMesh(mesh, false);
    mesh.setVerticesData("aux", SWORD_AUX, false, 2);

    mesh.alwaysSelectAsActiveMesh = true;
    mesh.isPickable = false;
    mesh.freezeWorldMatrix();
    mesh.doNotSyncBoundingInfo = true;
    mesh.metadata = { triangles: SWORD_TRIS, vertices: SWORD_VERTS };
    return mesh;
}
