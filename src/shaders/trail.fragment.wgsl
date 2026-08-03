// -----------------------------------------------------------------------------
// The sword trail — ice and gold.
//
// Additive, unlit, and deliberately not a texture. Everything here is a gradient
// evaluated from two coordinates, which is both cheaper than sampling and the only
// way the trail can stay crisp at any length: a strip texture stretched along a
// two-metre arc is a blurry band, where an analytic falloff is exact.
//
// The ribbon is four vertices wide rather than two, and that is what makes it
// *feathered*. An edge cannot be softened at the boundary of the geometry — there is
// nothing beyond it to fade into, so however gentle the gradient is, the last pixel
// is still a hard stop against the background. So the strip carries a margin past the
// blade on both sides, `uv.y` runs 0..1 across the whole thing including that margin,
// and the blade itself occupies the middle. Everything outside that span fades to
// nothing, which is where the soft edge comes from.
//
// Four things stacked, in the order they matter:
//
//   coverage     the feather. Zero at both extremes of the strip, full across the
//                blade's own span. Every other term is multiplied by it, so nothing
//                can reach an edge at full strength.
//   the core     a soft bright line near the point, which is the part the eye reads
//                as *the blade was here*. A gaussian rather than a step: a hard core
//                is a wire, and a wire is the thing this used to look like.
//   the ice      broad cold blue on the *outer* half, strongest toward the point.
//   the gold     a warm band on the *inner* half, with its own soft line through it.
//                Across the ribbon rather than mixed into it, which is the whole
//                difference: a gold-blue blend at every point averages to cyan-grey,
//                where gold inside and ice outside reads as a hot edge cooling as it
//                trails. The filaments survive, weighted into the gold so they are
//                bright threads within it rather than sparks over the whole thing.
//
// Then all of it multiplied by age, quadratically: linear fade leaves a visible end
// where the oldest sample dies, and squaring puts the fastest part of the fade at the
// tail so it thins out of existence.
// -----------------------------------------------------------------------------

varying vUV: vec2f;
varying vViewDist: f32;

uniform trailTint: vec3f;
uniform trailGold: vec3f;
uniform trailIntensity: f32;
uniform trailSeed: f32;

/** Where the blade's own span sits inside the strip. Outside this is feather. */
const SPAN_LO: f32 = 0.20;
const SPAN_HI: f32 = 0.80;

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let age = clamp(input.vUV.x, 0.0, 1.0);
    let y = clamp(input.vUV.y, 0.0, 1.0);

    // Age fade, squared so the tail thins rather than ending.
    let fade = (1.0 - age) * (1.0 - age);

    // The feather. Smooth in over the inner margin and out over the outer one, so both
    // edges of the ribbon are gradients and neither is a boundary.
    let cover = smoothstep(0.0, SPAN_LO, y) * (1.0 - smoothstep(SPAN_HI, 1.0, y));

    // 0 at the inner end of the blade, 1 at the point. The outer edge travelled
    // furthest and fastest, so this is also roughly how much light each part earned.
    let toward = smoothstep(SPAN_LO, SPAN_HI, y);

    // The ice core: a soft band just inside the point. Gaussian, because the previous
    // version used a power of a smoothstep and the result was a hard white wire.
    let dc = (y - 0.72) / 0.11;
    let core = exp(-dc * dc);

    // The gold, on the inner side. A broad warm field falling off before mid-ribbon,
    // plus its own soft line for definition — without the line the gold has no edge
    // and reads as a stain rather than as heat.
    let warm = 1.0 - smoothstep(SPAN_LO, 0.56, y);
    let dg = (y - 0.30) / 0.10;
    let goldCore = exp(-dg * dg);

    // Filaments. Two frequencies so the spacing is not obviously periodic, both keyed
    // to position along the arc rather than to time — a streak belongs to the piece of
    // arc it was born on, and animating it would make the trail crawl.
    let s = age * 26.0 + uniforms.trailSeed;
    let bands = sin(s) * 0.6 + sin(s * 2.37 + 1.7) * 0.4;
    let filament = smoothstep(0.55, 0.95, bands);

    // Ice outside, gold inside, and each fades where the other takes over.
    // Ice, and hard. Additive light over a snowfield lit to near-white needs real
    // magnitude to register at all: the tonemapper compresses the top end, so the blue
    // has to arrive well above 1 to survive to something that reads as blue.
    var color = uniforms.trailTint * (0.45 + 4.6 * toward);
    color += uniforms.trailGold * (warm * 1.25 + goldCore * 1.9 + filament * warm * 1.4);
    // The ice core is *tinted*, not white. A white core was washing the saturation out
    // of the whole ribbon: it sits in the middle of the brightest part, and additive
    // white over an already-bright blue is the fastest way to turn blue into nothing.
    // Kept blue-dominant and dimmer, so it reads as the hottest part of an ice colour
    // rather than as a white line with blue either side.
    color += vec3f(0.30, 0.72, 1.0) * core * 2.2;

    color *= cover * fade * uniforms.trailIntensity;

    // Fades with distance as well as with age. At forty metres a trail is a couple of
    // pixels wide, and full brightness there turns it into a hard bright line across
    // the screen — which is what would make four players fighting look like a laser
    // show rather than a snowfield.
    color *= 1.0 - smoothstep(30.0, 65.0, input.vViewDist);

    // Alpha is written as well as colour even though the blend is additive, because
    // the bloom threshold reads the composed image — a bright core should bloom, and
    // it is allowed above 1 for exactly that reason.
    fragmentOutputs.color = vec4f(color, cover * fade * (0.35 + 0.65 * toward));
}
