// Particle structure to save particle data for the compute shader
struct Particle {
  pos: vec2f,
  vel: vec2f,
  birth: f32,
  life: f32,
  prev: vec2f,
  origin: vec2f
};

@group(0) @binding(0) var<uniform> frame: f32;                         // Current frame count
@group(0) @binding(1) var<uniform> resolution: vec2f;                  // Screen aspect ratio
@group(0) @binding(2) var<uniform> emitter: vec4f;                     // Emitter properties: (x, y, vx, vy)
@group(0) @binding(3) var<uniform> emitter_active: f32;                // Boolean active boolean
@group(0) @binding(4) var<uniform> speed: f32;                         // Speed of all particles
@group(0) @binding(5) var<uniform> noise_randomizer: f32;              // Noise randomization value
@group(0) @binding(6) var<storage, read_write> state: array<Particle>; // State of all particles

// Hash function to generate kinda random values based on a 2D point
// Used for noise generation and randomizing particle properties
// https://www.reddit.com/r/GraphicsProgramming/comments/3kp644/this_generates_pseudorandom_numbers_fractsindota/
fn hash(point: vec2f) -> f32 {
  return fract(sin(dot(point, vec2f(120, 312))) * 42348.023778235);
}

// Noise function to generate a smoothed noise using a hash function
fn noise(point: vec2f) -> f32 {
  let cell_coords = floor(point);                                               // Get the integer cell coordinates
  let local_coords = fract(point);                                              // Get the local coordinates within the cell
  let top_left = hash(cell_coords + vec2f(0.0, 0.0));                           // Get the noise values at the top left of the cell
  let top_right = hash(cell_coords + vec2f(1.0, 0.0));                          // Get the noise values at the top right of the cell
  let bottom_left = hash(cell_coords + vec2f(0.0, 1.0));                        // Get the noise values at the bottom left of the cell
  let bottom_right = hash(cell_coords + vec2f(1.0, 1.0));                       // Get the noise values at the bottom right of the cell
  let smooth_factor = local_coords * local_coords * (3.0 - 2.0 * local_coords); // Smoothstep interpolation

  // interpolate the noise values based on the local coordinates to get a smooth noise value across the cell
  return mix(
    mix(top_left, top_right, smooth_factor.x),
    mix(bottom_left, bottom_right, smooth_factor.x),
    smooth_factor.y
  );
}

// Function to compute the flow field based on noise gradients
fn flow_field(position: vec2f, time: f32, scale: f32, drift: vec2f) -> vec2f {
  let sample_position = position * scale + drift * time;
  let epsilon = 0.02;                                             // Small offset to use in math
  let noise_up = noise(sample_position + vec2f(0.0, epsilon));    // Sample noise slightly up
  let noise_down = noise(sample_position - vec2f(0.0, epsilon));  // Sample noise slightly down 
  let noise_right = noise(sample_position + vec2f(epsilon, 0.0)); // Sample noise slightly to the right
  let noise_left = noise(sample_position - vec2f(epsilon, 0.0));  // Sample noise slightly to the left
  let gradient_x = (noise_right - noise_left) / (2.0 * epsilon);  // Approximate the x gradient using the average
  let gradient_y = (noise_up - noise_down) / (2.0 * epsilon);     // Approximate the y gradient using the average

  return vec2f(gradient_y, -gradient_x);                          // Return the gradient
}

// Function to respawn a particle by resetting state values
fn respawn_particle(particle_index: u32, current_time: f32) {
  let random_seed = f32(particle_index) + current_time * 8.0; // Random seed for the particle is generated using time

  // if emitter is dead set values to respawn
  if (emitter_active < 0.5) {
    state[particle_index].pos = vec2f(2.0, 2.0);
    state[particle_index].prev = vec2f(2.0, 2.0);
    state[particle_index].origin = vec2f(2.0, 2.0);
    state[particle_index].vel = vec2f(0.0, 0.0);
    state[particle_index].birth = current_time;
    state[particle_index].life = 1.0;
    return;
  }

  let aspect_ratio = resolution.x / resolution.y; // get aspect ratio

  // Random point inside a circle
  let random_angle = hash(vec2f(random_seed, 1.0)) * current_time; // Use hash to get a random angle
  let random_radius = sqrt(hash(vec2f(random_seed, 2.0))) * 0.08;  // Use hash to get a random radius

  // Aspect-corrected circular spawn offset
  let spawn_offset = vec2f(
    cos(random_angle) * random_radius / aspect_ratio,
    sin(random_angle) * random_radius
  );

  let spawn_position = emitter.xy + spawn_offset; // Get spawn position from offset (creates a more full look)

  // Randomize the particles initial velocity (also to create a more full look)
  let initial_velocity = vec2f(
    emitter.z * 0.22 + (hash(vec2f(random_seed, 3.0)) - 0.5) * 0.0004,
    max(
      0.00025,
      emitter.w * 0.10 + 0.00045 + hash(vec2f(random_seed, 4.0)) * 0.00035
    )
  );

  // Set particles new initial state values
  state[particle_index].pos = spawn_position;
  state[particle_index].prev = spawn_position;
  state[particle_index].origin = spawn_position;
  state[particle_index].vel = initial_velocity;
  state[particle_index].birth = current_time;
  state[particle_index].life = 1.0 + hash(vec2f(random_seed, 5.0)) * 0.6;
}

@compute
@workgroup_size(64)

// Computer shader
fn cs(@builtin(global_invocation_id) global_invocation_id: vec3u) {
  // assign an id to each particle
  let particle_index = global_invocation_id.x;           
  if (particle_index >= arrayLength(&state)) { return; }

  let current_time = frame * 0.01;                               // calculate current time using built in frame
  let random_seed = f32(particle_index);                         // use the index as random seed value from determinism and garunteed unique random values
  let particle_age = current_time - state[particle_index].birth; // get particle age  why subtracting time of birth from current time

  // check if the particle is hidden at the parked position
  let is_hidden =
    state[particle_index].pos.x > 1.5 ||
    state[particle_index].pos.y > 1.5;

  // hidden particles should only come back a few at a time
  if (is_hidden) {
    if (
      emitter_active > 0.5 &&
      hash(vec2f(random_seed, frame * 0.17)) > 0.975
    ) {
      respawn_particle(particle_index, current_time);
    }
    return;
  }

  // check if the particle is off screen
  let is_offscreen =
    state[particle_index].pos.y > 1.2 ||
    abs(state[particle_index].pos.x) > 1.25;

  // check if the particle should respawn
  let should_respawn =
    particle_age > state[particle_index].life ||
    is_offscreen;

  // if should respawn is true then respawn
  if (should_respawn) {
    respawn_particle(particle_index, current_time);
    return;
  }

  let safe_life = max(0.01, state[particle_index].life);                                                         // ensure no dividing by zero error
  let normalized_age = clamp(particle_age / safe_life, 0.0, 1.0);                                                // normalized the particles age between 0-1
  let aspect_ratio = resolution.x / resolution.y;                                                                // get screen aspect ratio
  let aspect_adjusted_position = vec2f(state[particle_index].pos.x * aspect_ratio, state[particle_index].pos.y); // scale position using aspect ratio to support different screen sizes
  let buoyancy_force = vec2f(0.0, speed * 0.15);                                                                 // force added to create a small amount of vertical movement scaled by speed
  let density_scale = mix(1.0, 3.0, clamp(noise_randomizer / 3.0, 0.0, 1.0));                                    // get normalized interpolated value of the intensity of the noise from the noise slider
  let strength_scale = noise_randomizer;                                                                         // get the strength value from the noise slider

  // 
  let coarse_flow = flow_field(
    aspect_adjusted_position, // this just makes sure that the particles don't warp based on screen resolution
    current_time,             // makes the field move over time instead of remaining stagnant
    2.6 * density_scale,      // this number is smaller so the motion patterns are broader and smoother
    vec2f(0.1, 0.4)           // this is the direction that the field moves over time
  );

  let fine_flow = flow_field(
    aspect_adjusted_position, // this just makes sure that the particles don't warp based on screen resolution
    current_time * 2.2,       // the field moves at a different speed so the layers are disjointed
    6.0 * density_scale,      // this number is larger so the motion patterns are finer ex: create smaller curls
    vec2f(-0.35, 1.8)         // this is the direction that the field moves over time
  );

  let turbulence_ramp = smoothstep(0.04, 0.40, normalized_age); // this value is used to scale how much the particles listen to the flow fields based on their age

  // Distance between the particle and its origin
  let source_distance = distance(
    state[particle_index].pos,
    state[particle_index].origin
  );

  // As the particle moves away from its origin this value decreases
  let source_distance_ramp = 1.0 - smoothstep(0.02, 0.65, source_distance);

  // variables to control how much the particle is affected by flowfields based on age
  let coarse_flow_strength = speed * mix(0.10, 0.32, turbulence_ramp) * strength_scale;
  let fine_flow_strength = speed * mix(0.03, 0.12, turbulence_ramp) * strength_scale;
  var flow_force = coarse_flow * coarse_flow_strength + fine_flow * fine_flow_strength;

  // the farther that particles have drifted from their origin, the weaker the flow force becomes
  // this keeps particles from spreading out too much, keeping them drifting somewhere near their origin
  flow_force *= source_distance_ramp;
  flow_force.x /= max(aspect_ratio, 0.0001);

  // the particle loses a bit of steam later in its life
  let drag_factor = mix(0.978, 0.988, 1.0 - turbulence_ramp);

  // calculate the next velocity of the particle
  var next_velocity = state[particle_index].vel * drag_factor;
  next_velocity += buoyancy_force;
  next_velocity += flow_force;

  let maximum_speed = max(speed, 0.0012);      // cap out the speed for consistency
  let velocity_length = length(next_velocity); // use to check speed
  if (velocity_length > maximum_speed) {
    next_velocity = normalize(next_velocity) * maximum_speed;
  }

  // set particle states before end loop
  state[particle_index].prev = state[particle_index].pos;
  state[particle_index].pos += next_velocity;
  state[particle_index].vel = next_velocity;
}
