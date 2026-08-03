// -----------------------------------------------------------------------------
// The ice sword — shading.
//
// Under two hundred triangles and one draw call, carrying two materials.
// Everything that makes it read as a forged object rather than as a grey prop is
// in this stage, and all of it is arithmetic: no textures beyond the sky LUT the
// whole scene already samples, no extra render target, no refraction pass.
//
// **Ice**, for the blade, the guard wings and the grip body:
//
//   facets      the normal comes from the derivatives of the world position, so
//               every face is exactly flat and every edge exactly hard. A blade
//               with smooth normals is a plastic sword.
//   absorption  ice takes red out about fifteen times faster than blue, so the
//               thick root of the blade is genuinely blue and the thin tip is
//               nearly clear. Same constant as the Crystallise prisms, so a
//               blade and a formation are the same substance.
//   edge light  the cutting edges glow. This is the one unphysical thing here
//               and it is what makes the object read at fifteen metres, where
//               the whole blade is a few pixels wide and refraction is invisible.
//   gold veins  thin seams inside the ice, keyed to *sword* space so they are
//               features of a solid rather than a pattern the light sweeps
//               through — shaded as metal, so the gold runs through the blade
//               itself and not just around its fittings.
//
// **Gold**, for the guard band and the set gem — plus the inlay engraved into
// the blade itself, which is gold shading applied to ice geometry rather than
// any extra triangles. Metal is the reason the sword reads as made: it is the only thing on the object that returns a hard
// highlight, and a highlight tracking across a moving blade is what the eye
// actually catches.
//
// Blended and depth-writing, for the reason set out at length in
// `crystal.fragment.wgsl`: the first surface at a pixel blends over the snow
// behind it, and every surface behind that one is depth-rejected, so the blade
// never blends over itself.
// -----------------------------------------------------------------------------

#include<snowNoise>
#include<snowShading>
#include<snowSpellLights>
#include<snowAtmosphere>

varying vWorld: vec3f;
varying vLocal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
varying vViewDist: f32;

var skyLUT: texture_2d<f32>;
var skyLUTSampler: sampler;
var cascade0: texture_2d<f32>;
var cascade0Sampler: sampler;
var cascade1: texture_2d<f32>;
var cascade1Sampler: sampler;
var cascade2: texture_2d<f32>;
var cascade2Sampler: sampler;

uniform cameraPos: vec3f;
uniform sunDir: vec3f;
uniform sunRadiance: vec3f;
uniform shR: array<vec4f, 9>;

uniform cascadeMatrices: array<mat4x4f, 3>;
uniform cascadeSplits: vec4f;
uniform cascadeParams: array<vec4f, 3>;
uniform shadowTexel: f32;
uniform shadowSoftness: f32;
uniform shadowBias: f32;

uniform fogDensity: f32;
uniform fogHeightFalloff: f32;
uniform fogStart: f32;
uniform aerialStrength: f32;
uniform ambientIntensity: f32;
uniform sssStrength: f32;
uniform swordGlow: f32;
uniform swordTime: f32;

uniform spellLightPos: array<vec4f, 4>;
uniform spellLightCol: array<vec4f, 4>;
uniform spellLightCount: f32;

#include<snowShadowLookup>

/// Absorption per metre, matched to the Crystallise prisms.
const ICE_ABSORB: vec3f = vec3f(2.35, 0.60, 0.24);
/// The colour the blade emits. Cold, and pushed past the sky's own blue so the
/// glow reads as light coming *out* rather than as more sky reflecting in.
const CORE: vec3f = vec3f(0.30, 0.78, 1.00);
/// Gold's normal-incidence reflectance. The strong red/green over blue is the
/// whole colour of the metal — gold has no albedo, only this.
const GOLD_F0: vec3f = vec3f(1.00, 0.72, 0.29);

/// Prefiltered sky along a direction, at a roughness. One lookup, and the LUT
/// already carries the solved snow bounce, so it is the whole environment.
fn envSky(dir: vec3f, rough: f32) -> vec3f {
    return textureSampleLevel(skyLUT, skyLUTSampler, dirToLatLong(dir), rough * 6.0).rgb;
}

/**
 * Polished metal, with grooves.
 *
 * A metal has no diffuse term, so this is entirely the environment and the sun:
 * prefiltered sky through a Fresnel that runs from gold at normal incidence to
 * white at grazing, plus one GGX lobe, plus a floor of sky irradiance so an
 * engraved face pointing into shadow is dark rather than black. `groove` both
 * roughens and occludes, which between them is what an engraved line looks like.
 */
fn goldShade(
    N: vec3f, V: vec3f, L: vec3f, mirror: vec3f,
    NdotV: f32, NdotL: f32, shadow: f32, sun: vec3f,
    groove: f32, wear: f32, shR: array<vec4f, 9>, ambient: f32
) -> vec3f {
    // Rougher than the silver this used to be, on purpose. A low-roughness metal
    // in front of a low warm sun returns the whole solar disc as one white streak,
    // which is the "reflects too strongly" failure — brushed gold spreads that
    // energy into a warm sheen instead of a flare.
    let rough = clamp(0.26 + 0.22 * wear + 0.34 * groove, 0.12, 0.95);
    let F = fresnelSchlickRough(NdotV, GOLD_F0, rough);

    var color = envSky(mirror, rough) * F;
    color += shIrradiance(N, shR) * ambient * GOLD_F0 * 0.16;

    if (NdotL > 0.0) {
        let H = normalize(V + L);
        let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), rough);
        let Vis = visSmithGGXCorrelated(NdotV, NdotL, rough);
        let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), GOLD_F0);
        // Deliberately less than the full lobe — see the roughness note.
        color += sun * D * Vis * Fs * NdotL * shadow * 0.55;
    }

    // Ambient occlusion in the engraving, and a cold rime in the deepest of it —
    // this sword has been sitting in a snowfield.
    color *= 1.0 - groove * 0.55;
    color += vec3f(0.32, 0.42, 0.55) * ambient * groove * 0.05;
    return color;
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let world = input.vWorld;
    let V = normalize(uniforms.cameraPos - world);
    let L = uniforms.sunDir;

    // Flat facet normal, straight from the geometry.
    let dx = dpdx(world);
    let dy = dpdy(world);
    var N = normalize(cross(dx, dy));
    if (dot(N, V) < 0.0) { N = -N; }
    let geoN = N;

    let NdotV = clamp(dot(N, V), 1e-4, 1.0);
    let NdotL = dot(N, L);
    let noiseRot = ign(input.position.xy) * 6.28318530718;
    let shadow = sunShadow(world, geoN, input.vViewDist, noiseRot);
    let mirror = reflect(-V, N);

    let sun = uniforms.sunRadiance;
    const INV_PI: f32 = 0.31830988618;

    // ---- which part of the sword this is ------------------------------------
    let part = input.vAux.x;
    let seed = input.vAux.y;
    let along = input.vUV.x;   // 0 at the guard, 1 at the tip
    let lateral = input.vUV.y; // 0 on the spine, 1 on the cutting edge

    let grain = noise3(input.vLocal * 120.0 + seed * 17.0) * 0.5 + 0.5;

    var color: vec3f;
    var alpha: f32;
    var albedo: vec3f;
    var rough: f32;
    var f0: vec3f;

    if (part > 2.5) {
        // -------------------------------------------------------------- gold
        //
        // The engraving is two families of line in sword space: rings around the
        // hilt, and a fine spiral of chased detail across them. Both are
        // `1 - |noise|` style ridges rather than sine bands, because a perfectly
        // regular groove reads as a machined thread.
        let rings = abs(fract(input.vLocal.y * 46.0) - 0.5) * 2.0;
        let chase = abs(fract(input.vLocal.y * 9.0 + atan2(input.vLocal.z, input.vLocal.x) * 1.9) - 0.5) * 2.0;
        let groove = clamp(
            smoothstep(0.74, 0.99, rings) * 0.8 + smoothstep(0.86, 1.0, chase) * 0.5,
            0.0, 1.0
        );
        let wear = grain;

        color = goldShade(
            N, V, L, mirror, NdotV, NdotL, shadow, sun,
            groove, wear, uniforms.shR, uniforms.ambientIntensity
        );
        // The metal picks up the blade's light where it sits next to it.
        color += CORE * groove * 0.22 * uniforms.swordGlow;

        albedo = GOLD_F0;
        rough = 0.16;
        f0 = GOLD_F0;
        alpha = 1.0;
    } else {
        // --------------------------------------------------------------- ice
        let isBlade = 1.0 - smoothstep(0.25, 0.75, part);
        let isGrip = smoothstep(1.25, 1.75, part);
        let isGuard = clamp(1.0 - isBlade - isGrip, 0.0, 1.0);

        // ---- frost ----------------------------------------------------------
        // The grip is rimed hard — it is the part a hand has been holding, and it
        // is also the part that must not be transparent, because a see-through
        // handle makes the whole object read as an outline. The blade is frosted
        // only where it grows out of the guard.
        let frost = clamp(
            isGrip * (0.60 + 0.32 * grain)
            + isGuard * (0.20 + 0.24 * grain)
            + isBlade * (1.0 - smoothstep(0.0, 0.18, along)) * (0.20 + 0.28 * grain),
            0.0, 1.0
        );

        // ---- gold veins -----------------------------------------------------
        // The fracture seams, re-purposed. They used to glow cold from inside;
        // they are now veins of gold running through the crystal — the same thin
        // `1 - |noise|` lines, shaded as lit metal rather than as emission. This
        // is most of what makes the *blade* read as gold-and-ice rather than as
        // ice with a gold handle: the metal is in the substance, not just on the
        // fittings.
        let fz = input.vLocal * vec3f(34.0, 11.0, 34.0) + seed * 4.0;
        let seam = pow(1.0 - abs(noise3(fz)), 9.0);
        let seamFine = pow(1.0 - abs(noise3(fz * 2.7 + 11.0)), 14.0);
        let vein = clamp(seam * 0.9 + seamFine * 0.55, 0.0, 1.0) * (1.0 - frost) * isBlade;

        // ---- the gold inlay -----------------------------------------------
        //
        // Applied to the blade's own triangles rather than modelled: a rail up
        // each flat a sixth of the way in from the spine, and a chain of chevrons
        // engraved inside it. It stops well short of the point, the way a real
        // fuller does, and it is the detail that says this blade was worked.
        let rail = 1.0 - smoothstep(0.0, 0.075, abs(lateral - 0.18));
        let chevron = abs(fract(along * 9.0 - lateral * 0.55) - 0.5) * 2.0;
        let chain = smoothstep(0.72, 0.96, chevron)
                  * (1.0 - smoothstep(0.02, 0.16, lateral));
        let inlay = clamp(rail + chain, 0.0, 1.0)
                  * isBlade
                  * smoothstep(0.01, 0.06, along)
                  * (1.0 - smoothstep(0.80, 0.97, along))
                  * (1.0 - frost);

        // ---- transmission ---------------------------------------------------
        // Optical path, and these numbers are much longer than the blade is
        // thick. That is deliberate and it is the fix for the sword being
        // invisible: shading it as *clear* ice was honest and it meant the blade
        // showed the snowfield straight through itself, which in front of a
        // snowfield is a snowfield. This is glacier ice — dense with trapped air,
        // so a ray entering it scatters many times and travels far further than
        // the four centimetres of geometry it crossed. The result is a body with
        // a real glacial blue in it, which is both what thick ice looks like and
        // an object the eye can find.
        let thickness = mix(0.155 * (1.0 - 0.40 * along), 0.26, clamp(isGrip + isGuard, 0.0, 1.0));
        let path = clamp(thickness * (0.85 + 2.8 * (1.0 - NdotV)), 0.02, 1.3);
        let transmit = exp(-ICE_ABSORB * path);

        // Refraction, with dispersion, against the sky LUT — which holds the sky
        // and the solved snow bounce together, so one lookup along the bent ray
        // is a defensible estimate of whatever is behind the blade.
        let rr = refract(-V, N, 1.0 / 1.3050);
        let rg = refract(-V, N, 1.0 / 1.3090);
        let rb = refract(-V, N, 1.0 / 1.3170);
        let dr = select(mirror, rr, dot(rr, rr) > 0.5);
        let dg = select(mirror, rg, dot(rg, rg) > 0.5);
        let db = select(mirror, rb, dot(rb, rb) > 0.5);

        let behind = vec3f(
            envSky(dr, 0.15).r,
            envSky(dg, 0.15).g,
            envSky(db, 0.15).b
        );
        color = behind * transmit;

        // Backlight: sun behind the blade lights it along its whole length,
        // because every inclusion in the ice scatters. The 1/PI belongs in front
        // of a scattering lobe.
        let through = backScatter(N, L, V, 0.42, 2.2, 1.0);
        let deepTint = mix(vec3f(0.42, 0.74, 1.0), vec3f(0.86, 0.95, 1.0), exp(-path * 2.5));
        color += sun * INV_PI * deepTint * through * uniforms.sssStrength * 1.5
               * mix(0.25, 1.0, shadow);

        // Sky through the body, so a blade in shadow is still ice and not a hole.
        // Carrying more of it than a thin crystal would: bubble-laden ice is a
        // diffuser, and this term is what gives the body its own brightness
        // instead of borrowing the field's.
        color += shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity * INV_PI
               * deepTint * 1.4;

        // ---- the light in the ice -------------------------------------------
        //
        // Two emitters: a hard line on the cutting edges and a soft bloom in the
        // body of the blade. The old third one — the fractures glowing from
        // inside — became the gold veins, which are lit rather than lighting.
        //
        // The pulse is slow and shallow — one and a bit seconds, a seventh of the
        // amplitude. Anything faster reads as a UI element blinking.
        if (uniforms.swordGlow > 0.001) {
            let pulse = 0.86 + 0.14 * sin(uniforms.swordTime * 1.9 + along * 3.2);
            let edge = smoothstep(0.58, 1.0, lateral) * isBlade;
            let spine = (1.0 - smoothstep(0.0, 0.45, lateral)) * isBlade * 0.45;
            // Brighter toward the point, where the blade is thinnest and least
            // absorbing — the light has less ice to get out through.
            let reach = 0.55 + 0.75 * along;

            var emit = CORE * (edge * 3.2 + spine) * reach;
            emit += CORE * isGuard * 0.35 * (0.4 + 0.6 * grain);
            color += emit * pulse * uniforms.swordGlow;
        }

        // ---- frosted skin ---------------------------------------------------
        if (frost > 0.002) {
            let fa = vec3f(0.86, 0.90, 0.96);
            var fc = fa * INV_PI * sun * wrapDiffuse(NdotL, 0.62) * shadow;
            fc += fa * INV_PI * shIrradiance(N, uniforms.shR) * uniforms.ambientIntensity;
            fc += snowSubsurface(N, L, V, sun, 0.4, uniforms.sssStrength, 1.3)
                * fa * mix(0.4, 1.0, shadow);
            color = mix(color, fc, frost * 0.85);
        }

        // ---- surface --------------------------------------------------------
        let iceRough = mix(0.085, 0.42, frost);
        let F = fresnelSchlick(NdotV, vec3f(0.021));
        // Deliberately less than the full Fresnel. At grazing incidence the
        // physical answer is "you see the sky", and the sky over a snowfield is
        // the same brightness as the snowfield — so obeying it exactly replaces
        // the one part of the blade that could have had an outline with the
        // background.
        color = mix(color, envSky(mirror, iceRough), F * 0.60 * (1.0 - frost * 0.75));

        if (NdotL > 0.0) {
            let H = normalize(V + L);
            let D = distributionGGX(clamp(dot(N, H), 0.0, 1.0), iceRough);
            let Vis = visSmithGGXCorrelated(NdotV, NdotL, iceRough);
            let Fs = fresnelSchlick(clamp(dot(V, H), 0.0, 1.0), vec3f(0.021));
            // Halved: at this facet size the full lobe strobes as the arm swings,
            // and a blade that flares every time it crosses the sun line is the
            // single strongest "too reflective" signal on the screen.
            color += sun * D * Vis * Fs * NdotL * shadow * 0.5;
        }

        // ---- silhouette rim -------------------------------------------------
        //
        // The eye finds objects by their edges, and a transparent object in front
        // of a bright field has none. No amount of internal detail fixes that;
        // this term is the one thing that guarantees an outline, and it costs a
        // pow. Cold rather than white, so it reads as the ice lighting its own
        // edge rather than as a selection highlight.
        let rim = pow(1.0 - NdotV, 3.0) * (1.0 - frost * 0.5);
        color += CORE * rim * (1.0 + 0.9 * uniforms.swordGlow);

        // ---- the veins, as metal ---------------------------------------------
        // After the surface terms, because they replace the ice locally: a vein
        // of gold has no transmission and no cold rim, it is simply lit. A hint
        // of the blade's glow catches the metal so the veins stay legible in
        // shadow.
        if (vein > 0.003) {
            let vg = goldShade(
                N, V, L, mirror, NdotV, NdotL, shadow, sun,
                0.30, grain, uniforms.shR, uniforms.ambientIntensity
            );
            color = mix(color, vg, clamp(vein * 1.5, 0.0, 0.92));
            color += GOLD_F0 * CORE * vein * 0.18 * uniforms.swordGlow;
        }

        // ---- the inlay, over the top ----------------------------------------
        // Blended in last, because it replaces the ice rather than shading with
        // it: an engraved gold line is metal, and metal has no transmission.
        if (inlay > 0.002) {
            let metal = goldShade(
                N, V, L, mirror, NdotV, NdotL, shadow, sun,
                0.35, grain, uniforms.shR, uniforms.ambientIntensity
            );
            color = mix(color, metal, inlay * 0.88);
            // The engraving carries a little of the blade's own light, which is
            // what makes the pattern legible at distance instead of being detail
            // that vanishes past five metres.
            color += CORE * inlay * 0.30 * uniforms.swordGlow;
        }

        albedo = mix(vec3f(0.30, 0.62, 0.86), vec3f(0.88), frost);
        rough = iceRough;
        f0 = vec3f(0.021);

        // ---- opacity --------------------------------------------------------
        // The floor is the important number here. At 0.42 the blade was a pane of
        // glass held up in front of a white field and it disappeared; a solid
        // object that happens to refract is both easier to read and closer to what
        // thick, bubbled ice actually is. Everything above the floor is the same
        // three things as before — path, grazing angle, frost — plus the engraving
        // and the glow, which have to carry alpha with them or the brightest part
        // of the blade is also its most transparent, and that reads as fog.
        alpha = clamp(
            0.70
            + 0.20 * (1.0 - exp(-path * 2.6))
            + 0.22 * (1.0 - NdotV)
            + frost * 0.30
            + inlay * 0.5
            + vein * 0.45
            + smoothstep(0.58, 1.0, lateral) * isBlade * 0.30,
            0.0, 1.0
        );
    }

    if (uniforms.spellLightCount > 0.5) {
        color += spellLightingSurface(
            world, N, V, albedo, f0, rough, 0.5,
            uniforms.spellLightPos, uniforms.spellLightCol, uniforms.spellLightCount
        );
    }

    color = applyAerial(
        color, uniforms.cameraPos, world, -V, L,
        skyLUT, skyLUTSampler, sun,
        uniforms.fogDensity, uniforms.fogHeightFalloff, uniforms.fogStart,
        uniforms.aerialStrength
    );

    fragmentOutputs.color = vec4f(color, alpha);
}
