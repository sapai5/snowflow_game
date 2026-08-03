// The sword trail — a ribbon swept from the path the edge took.
//
// `position` is world space and is rewritten every frame; `uv` never changes and is
// what carries the geometry's meaning:
//
//   uv.x  age along the strip. 0 is the sample taken this frame, 1 is the oldest one
//         still alive. Because the CPU writes the ring buffer in age order, this is a
//         static attribute rather than something that has to be uploaded — the only
//         thing that moves is where each sample *is*.
//   uv.y  across the ribbon. 0 is the inner edge, part way down the blade; 1 is the
//         point. The outer edge travels furthest and fastest, so this is also
//         roughly "how much light this bit of the trail earned".
//
// No normal and no lighting. A contrail is emission — it is the afterimage of a
// glowing edge, not a surface with a material — so there is nothing here for a light
// to do and the fragment stage is a gradient.

attribute position: vec3f;
attribute uv: vec2f;

uniform viewProjection: mat4x4f;
uniform cameraPos: vec3f;

varying vUV: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let p = vertexInputs.position;
    vertexOutputs.vUV = vertexInputs.uv;
    vertexOutputs.vViewDist = distance(p, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * vec4f(p, 1.0);
}
