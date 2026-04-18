// Vertex input data for each particle quad
struct VertexInput {
  @location(0) position: vec2f,
  @builtin(instance_index) instance_index: u32,
};

// Particle structure to save particle data for the render shader
struct Particle {
  pos: vec2f,
  vel: vec2f,
  birth: f32,
  life: f32,
  prev: vec2f,
  origin: vec2f
};

@group(0) @binding(0) var<uniform> frame: f32;            // Current frame count
@group(0) @binding(1) var<uniform> resolution: vec2f;     // Canvas width and height
@group(0) @binding(2) var<storage> state: array<Particle>; // State of all particles

// Values passed from the vertex shader to the fragment shader
struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) local_position: vec2f,
  @location(1) particle_age: f32,
  @location(2) particle_life: f32,
};

@vertex
// Vertex shader
fn vs(input: VertexInput) -> VertexOutput {
  let aspect_ratio = resolution.x / resolution.y; // Get the aspect ratio
  let particle = state[input.instance_index];     // Get this particles data

  let particle_age = max(0.0, frame * 0.01 - particle.birth);          // Get how long the particle has been alive
  let particle_life = max(0.001, particle.life);                       // Make sure the life value is safe to divide by
  let normalized_age = clamp(particle_age / particle_life, 0.0, 1.0);  // Convert age into a 0 to 1 value

  let growth_factor = smoothstep(0.0, 0.55, normalized_age); // Slowly grow the particle over time
  let particle_radius = 0.014 + 0.012 * growth_factor;       // Set the size of the particle

  // Build the offset for each corner of the particle quad
  let particle_offset = vec2f(
    input.position.x * particle_radius / aspect_ratio,
    input.position.y * particle_radius
  );

  var output: VertexOutput;
  output.position = vec4f(particle.pos + particle_offset, 0.0, 1.0); // Move the quad to the particles position
  output.local_position = input.position;                            // Save local quad position for the fragment shader
  output.particle_age = particle_age;                                // Pass particle age to the fragment shader
  output.particle_life = particle_life;                              // Pass particle life to the fragment shader
  return output;
}

@fragment
// Fragment shader
fn fs(input: VertexOutput) -> @location(0) vec4f {
  let radial_distance = length(input.local_position); // Get how far this pixel is from the center of the particle
  if (radial_distance > 1.0) {
    discard; // Remove pixels outside the circular particle shape
  }
  let normalized_age = clamp(input.particle_age / input.particle_life, 0.0, 1.0); // Convert age into a 0 to 1 value again
  let fade_in = smoothstep(0.0, 0.12, input.particle_age);                        // Fade the particle in when it is first born
  let fade_out = 1.0 - smoothstep(0.55, 1.0, normalized_age);                     // Fade the particle out as it gets older
  let soft_falloff = 1.0 - smoothstep(0.10, 1.0, radial_distance);                // Fade the edges of the particle
  let alpha = 0.16 * fade_in * fade_out * soft_falloff;                           // Final transparency of the particle
  let color = vec3f(0.84, 0.84, 0.84);                                            // Particle color
  return vec4f(color, alpha);                                                     // Draw the final particle color and transparency
}
