// The slash arc — the sheet the blade swept, not the contrail behind its edge.
//
// `position` is world space and is rewritten every frame. `uv` never changes and carries
// what the geometry means:
//
//   uv.x  progress toward the leading edge. 0 is the oldest station in the swing, 1 is
//         where the blade is now. The opposite sense to the trail's `uv.x`, which is
//         age — a sheet is read from its tail toward the edge that is cutting, and the
//         alternative is writing `1 - uv.x` in a dozen places and forgetting one.
//   uv.y  across the sheet. 0 is the hilt rim, 1 is the far rim well past the point.
//         Both are feather edges; the white-hot core is in between.
//
// No normal and no lighting. This is emission — a sheet of light the swing left in the
// air, not a surface with a material — so there is nothing here for a light to do.

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
