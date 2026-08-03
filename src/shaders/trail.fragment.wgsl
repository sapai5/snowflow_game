// -----------------------------------------------------------------------------
// The sword trail — the bright leading edge of a swing.
//
// Additive, unlit, and deliberately not a texture. Everything here is a gradient
// evaluated from two coordinates, which is both cheaper than sampling and the only way
// the trail can stay crisp at any length: a strip texture stretched along a two-metre
// arc is a blurry band, where an analytic falloff is exact.
//
// It is not subtle, and that is a correction rather than a preference. An earlier pass
// made it a narrow deep-blue-and-gold ribbon on the reasoning that a contrail is an
// afterimage and afterimages are faint. The reference art is the opposite: a swing throws
// a brilliant sheet with a white-hot middle, and a trail that has to be looked for is not
// doing its job. The gold went with that decision — the reference has none, and a warm
// band on the inner edge pulled the eye away from the hot-to-cold gradient that is the
// whole read.
//
// The ribbon is four vertices wide rather than two, and that is what makes it
// *feathered*. An edge cannot be softened at the boundary of the geometry — there is
// nothing beyond it to fade into, so however gentle the gradient is, the last pixel is
// still a hard stop against the background. So the strip carries a margin past the blade
// on both sides, `uv.y` runs 0..1 across the whole thing including that margin, and the
// blade itself occupies the middle. Everything outside that span fades to nothing, which
// is where the soft edge comes from.
//
// Four things stacked, in the order they matter:
//
//   coverage     the feather. Zero at both extremes of the strip, full across the
//                blade's own span. Every other term is multiplied by it, so nothing can
//                reach an edge at full strength.
//   the body     saturated blue, brightening steeply toward the point. The outer edge
//                travelled furthest and fastest, so it earned the most light.
//   the core     white-hot, broad, sitting just inside the point. This is the part the
//                eye reads as *the blade was here*. A gaussian rather than a step: a
//                hard core is a wire, and a wire is what this used to look like.
//   filaments    streaks along the arc, which is what stops a wide ribbon reading as a
//                painted band. They modulate the body and the core rather than being
//                added over them, so the ribbon looks made of strokes rather than
//                sprinkled with sparks.
//
// Then all of it multiplied by age, quadratically: a linear fade leaves a visible end
// where the oldest sample dies, and squaring puts the fastest part of the fade at the
// tail so it thins out of existence.
// -----------------------------------------------------------------------------

varying vUV: vec2f;
varying vViewDist: f32;

uniform trailTint: vec3f;
uniform trailHot: vec3f;
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

    // 0 at the inner end of the blade, 1 at the point.
    let toward = smoothstep(SPAN_LO, SPAN_HI, y);

    // Filaments. Two frequencies so the spacing is not obviously periodic, both keyed to
    // position along the arc rather than to time — a streak belongs to the piece of arc it
    // was born on, and animating it would make the trail crawl.
    //
    // The band is wide, unlike the previous version's narrow threshold: at 40 cm across,
    // a ribbon needs most of its width to be *made of* filaments rather than to have a
    // few laid over it.
    let s = age * 26.0 + uniforms.trailSeed;
    let bands = sin(s) * 0.6 + sin(s * 2.37 + 1.7) * 0.4;
    let filament = smoothstep(-0.45, 0.9, bands);

    // The body. Hard, because additive light over a snowfield lit to near-white needs real
    // magnitude to register at all: the tonemapper compresses the top end, so the blue has
    // to arrive well above 1 to survive to something that still reads as blue.
    var color = uniforms.trailTint * (1.1 + 7.5 * toward) * (0.5 + 0.5 * filament);

    // The hot core, just inside the point and broad enough to be a band rather than a
    // line. Gaussian; a power-of-smoothstep here was what made it a white wire.
    let dc = (y - 0.66) / 0.17;
    let core = exp(-dc * dc);
    color += uniforms.trailHot * core * 5.2 * (0.55 + 0.45 * filament);

    // A second, tighter core right at the edge: the instant of the cut. Narrow, so it
    // reads as a highlight on the leading edge rather than widening the hot band.
    // Just inside SPAN_HI rather than on it: coverage is already fading at the span
    // boundary, so a highlight placed exactly there is half thrown away.
    let de = (y - 0.775) / 0.055;
    color += uniforms.trailHot * exp(-de * de) * 3.4;

    color *= cover * fade * uniforms.trailIntensity;

    // Fades with distance as well as with age. At forty metres a trail is a couple of
    // pixels wide, and full brightness there turns it into a hard bright line across the
    // screen — which is what would make four players fighting look like a laser show
    // rather than a snowfield.
    color *= 1.0 - smoothstep(30.0, 65.0, input.vViewDist);

    // Alpha is written as well as colour even though the blend is additive, because the
    // bloom threshold reads the composed image — a bright core should bloom, and it is
    // allowed above 1 for exactly that reason.
    fragmentOutputs.color = vec4f(color, cover * fade * (0.45 + 0.55 * toward));
}
