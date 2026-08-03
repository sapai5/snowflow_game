// The slash arc's shading.
//
// Four things stacked, in the order they matter:
//
//   the rim        deep blue, feathered to nothing at both edges of the sheet.
//   the core       white-hot, well inside the rim. The sheet is additive over snow that
//                  is already bright, so the middle saturates to white on its own — the
//                  work here is stopping that from happening everywhere, which is what
//                  keeps a blue rim blue.
//   striations     filaments running the length of the arc. This is the single feature
//                  that distinguishes the reference art from a plain gradient: the sheet
//                  reads as many overlapping strokes rather than one smooth band.
//   voids          elongated dark lenses inside the sheet. Not holes for their own sake —
//                  they are what implies volume, because a sheet with gaps in it reads as
//                  something with a front and a back rather than as a decal.
//
// Everything is analytic. A texture would be one more asset to license and this is a
// handful of sines that can be tuned by anyone reading the file.

uniform slashCore: vec3f;
uniform slashRim: vec3f;
uniform slashIntensity: f32;
uniform slashFade: f32;
uniform slashSeed: f32;

varying vUV: vec2f;
varying vViewDist: f32;

const PI: f32 = 3.14159265;

/**
 * An elongated dark lens.
 *
 * Anisotropic on purpose: circular voids read as bubbles, and stretching them along the
 * arc makes them read as the gaps between strokes.
 */
fn lens(along: f32, across: f32, cx: f32, cy: f32, rx: f32, ry: f32) -> f32 {
    let dx = (along - cx) / rx;
    let dy = (across - cy) / ry;
    let d = sqrt(dx * dx + dy * dy);
    return 1.0 - smoothstep(0.35, 1.0, d);
}

@fragment
fn main(input: FragmentInputs) -> FragmentOutputs {
    let along = clamp(fragmentInputs.vUV.x, 0.0, 1.0);
    let across = clamp(fragmentInputs.vUV.y, 0.0, 1.0);

    // Distance from whichever rim is nearer: 0 at both edges, 0.5 in the middle.
    let edge = min(across, 1.0 - across);

    // Two separate falloffs rather than one. The rim decides where the sheet *ends* and
    // has to be soft over a narrow band; the core decides where it turns white and has to
    // be soft over a wide one. Driving both from a single smoothstep gives either a hard
    // edge or a sheet with no blue left in it.
    let rim = smoothstep(0.0, 0.075, edge);
    let core = smoothstep(0.14, 0.44, edge);

    // Striations. Two sines at incommensurate rates, so the filaments do not repeat
    // across the sheet the way a single one would read as a comb. The seed shifts them
    // per swing, which stops consecutive slashes looking stamped from the same die.
    let ph = across * 17.0 + uniforms.slashSeed * 6.3;
    let fine = sin(ph) * sin(ph * 0.37 + 2.1);
    // A slower band that drifts with `along`, so the filaments lean along the arc instead
    // of sitting perpendicular to it — a swing drags its own light.
    let drift = sin(across * 5.3 - along * 2.4 + uniforms.slashSeed * 3.0);
    let streak = 0.60 + 0.28 * fine + 0.12 * drift;

    // The voids. Placed toward the middle of the sheet where there is brightness to
    // remove; one large and one small, at different rates along the arc.
    let v = clamp(
        lens(along, across, 0.44, 0.54, 0.30, 0.19) +
        lens(along, across, 0.72, 0.38, 0.17, 0.13) * 0.8,
        0.0, 1.0
    );

    // The leading edge: a hard bright line where the blade is now. This is what makes the
    // arc look like it is being cut rather than fading in from nowhere.
    let lead = smoothstep(0.88, 1.0, along);

    // Age. The tail is dimmer, and on a curve rather than linearly — a linear fade along
    // the arc reads as a gradient someone drew, where a steep one reads as light that has
    // had time to go out.
    let age = pow(along, 0.55);

    // Boldness. The sheet is the body of the effect and the reference art is mostly
    // sheet, so this is not a subtle wash: the base is raised and the striations modulate
    // it downward rather than the other way round, which keeps the whole crescent present
    // instead of leaving it as a few bright threads over nothing.
    var a = rim * age * (0.45 + 0.85 * streak) * (1.0 - v * 0.78) * 1.55;
    a = a + lead * rim * 0.85;

    // Close to the camera the sheet fills the frame and additive light on that much of
    // the screen is a white-out. Pulled down hard inside a metre and a half, which is
    // roughly where the swing passes the lens.
    let near = smoothstep(0.35, 1.6, fragmentInputs.vViewDist);
    a = a * near * uniforms.slashFade * uniforms.slashIntensity;

    // Colour last. The core is reached by brightness rather than by mixing toward white,
    // because an additive surface that is already at the top of the range desaturates
    // itself — so the mix only has to get it close and the tonemapper finishes the job.
    let whiteness = core * (0.55 + 0.55 * streak) + lead * 0.65;
    let tint = mix(uniforms.slashRim, uniforms.slashCore, clamp(whiteness, 0.0, 1.0));

    fragmentOutputs.color = vec4f(tint * a, a);
}
