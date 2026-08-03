// The ice sword — vertex placement.
//
// The geometry is static and lives in the sword's own space, with the pommel at
// the origin and the blade running up +Y. One rigid matrix per frame carries it
// into the world: the right hand's skinning frame times a fixed grip offset,
// composed on the CPU in `sword.js`.
//
// Named `swordWorld` rather than `world` deliberately — Babylon auto-binds a
// uniform called `world` from the mesh's own transform, which for this mesh is
// the identity, and it would silently win.
//
// No normal is emitted. The fragment stage takes it from the derivatives of the
// world position, which gives exactly flat facets and exactly hard edges between
// them. That is what makes the blade read as cut crystal rather than as glass:
// adjacent facets return wildly different amounts of sky, and the jump between
// them is the material.

attribute position: vec3f;
attribute uv: vec2f;   // (along the piece 0..1, spine 0 -> edge 1)
attribute aux: vec2f;  // (part id: 0 blade / 1 guard / 2 grip, seed)

uniform viewProjection: mat4x4f;
uniform swordWorld: mat4x4f;
uniform cameraPos: vec3f;

varying vWorld: vec3f;
varying vLocal: vec3f;
varying vUV: vec2f;
varying vAux: vec2f;
varying vViewDist: f32;

@vertex
fn main(input: VertexInputs) -> FragmentInputs {
    let w = uniforms.swordWorld * vec4f(vertexInputs.position, 1.0);

    vertexOutputs.vWorld = w.xyz;
    // Sword space, kept for the internal fractures. Keying those to world
    // position would swim the flaws through the ice every time the arm moved,
    // which is the one thing a solid must never do.
    vertexOutputs.vLocal = vertexInputs.position;
    vertexOutputs.vUV = vertexInputs.uv;
    vertexOutputs.vAux = vertexInputs.aux;
    vertexOutputs.vViewDist = distance(w.xyz, uniforms.cameraPos);
    vertexOutputs.position = uniforms.viewProjection * w;
}
