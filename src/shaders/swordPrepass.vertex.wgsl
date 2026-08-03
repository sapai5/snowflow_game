// Depth-prepass vertex shader for the ice sword.
//
// Writes the specular mask, on the same grounds as the crystals: the blade is a
// mirror in a field of matte snow, and the reflection pass gates on this.

attribute position: vec3f;

uniform viewProjection: mat4x4f;
uniform swordWorld: mat4x4f;

varying vViewZ: f32;
varying vMask: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let clip = uniforms.viewProjection * uniforms.swordWorld * vec4f(vertexInputs.position, 1.0);
    vertexOutputs.vViewZ = clip.w;
    vertexOutputs.vMask = 1.0;
    vertexOutputs.position = clip;
}
