import { default as gulls } from './gulls.js'

const sg = await gulls.init()
const render_shader = await gulls.import('./render.wgsl')
const compute_shader = await gulls.import('./compute.wgsl')

const num_particles = 100000                                    // Number of particles in the simulation
const num_properties = 10                                       // Each particle has 10 properties that it tracks
const hidden_position = 2.0      

// Initialize the array that stores all particles
const state = new Float32Array(num_particles * num_properties)  
for (let property_index = 0; property_index < num_particles * num_properties; property_index += num_properties) {
  state[property_index + 0] = hidden_position
  state[property_index + 1] = hidden_position
  state[property_index + 2] = 0.0
  state[property_index + 3] = 0.0
  state[property_index + 4] = 0.0
  state[property_index + 5] = 1.0
  state[property_index + 6] = hidden_position
  state[property_index + 7] = hidden_position
  state[property_index + 8] = hidden_position
  state[property_index + 9] = hidden_position
}

const state_buffer = sg.buffer(state)                         // Buffer to store the particle data
const frame_uniform = sg.uniform(0)                           // Buffer for the frame index
const resolution_uniform = sg.uniform([sg.width, sg.height])  // Buffer for the canvas resolution
const emitter_uniform = sg.uniform([0, 0, 0, 0])              // Buffer for the emitter properties
const emitter_active_uniform = sg.uniform([0])                // Buffer for the emitter active state
const speed_uniform = sg.uniform([0.00450])                   // Buffer for the simulation speed
const noise_randomizer_uniform = sg.uniform([1.0])            // Buffer for the noise randomizer

// Interactive UI elements
const speed_slider = document.getElementById('speed')
const speed_value = document.getElementById('speed-value')
const noise_randomizer_slider = document.getElementById('noise-randomizer')
const noise_randomizer_value = document.getElementById('noise-randomizer-value')

// Saved values for the sliders to be used in the render loop
let saved_speed = Number(speed_slider?.value ?? 0.0045)
let saved_noise_randomizer = Number(noise_randomizer_slider?.value ?? 1.0)

// Functions to synchronize the slider values with the saved values and update the display
const sync_speed = () => {
  saved_speed = Number(speed_slider?.value ?? 0.0045)
  if (speed_value) speed_value.textContent = saved_speed.toFixed(5)
}

const sync_noise_randomizer = () => {
  saved_noise_randomizer = Number(noise_randomizer_slider?.value ?? 1.0)
  if (noise_randomizer_value) {
    noise_randomizer_value.textContent = saved_noise_randomizer.toFixed(2)
  }
}

// Event listeners for the sliders to update the saved values and display when the sliders are adjusted
speed_slider?.addEventListener('input', sync_speed)
noise_randomizer_slider?.addEventListener('input', sync_noise_randomizer)

// Initial synchronization of the slider values and display
sync_speed()
sync_noise_randomizer()

const canvas = sg.canvas

const emitter = {
  active: false,
  x: 0,
  y: 0,
  vx: 0,
  vy: 0,
  last_x: 0,
  last_y: 0,
  last_time: 0
}

// Function to update the emitter's position and velocity based on pointer input
const update_emitter_from_pointer = event => {
  const canvas_rect = canvas.getBoundingClientRect()

  // Get the pointers x value
  const pointer_x =
    ((event.clientX - canvas_rect.left) / canvas_rect.width) * 2 - 1

  // Get the pointers y value
  const pointer_y =
    1 - ((event.clientY - canvas_rect.top) / canvas_rect.height) * 2

  // Calculate time
  const current_time = performance.now()
  const delta_time = Math.max(1, current_time - emitter.last_time)

  // Calculate the velocity of the mouse in x and y directions, clamping within a reasonable range
  emitter.vx = Math.max(
    -0.03,
    Math.min(0.03, ((pointer_x - emitter.last_x) / delta_time) * 8.0)
  )

  emitter.vy = Math.max(
    -0.03,
    Math.min(0.03, ((pointer_y - emitter.last_y) / delta_time) * 8.0)
  )

  // Clamp the emitter's position within the canvas bounds
  emitter.x = Math.max(-1, Math.min(1, pointer_x))
  emitter.y = Math.max(-1, Math.min(1, pointer_y))

  // Save the previous position and time to calculate velocity on the next update
  emitter.last_x = emitter.x
  emitter.last_y = emitter.y
  emitter.last_time = current_time
}

// Pointer down event
canvas.addEventListener('pointerdown', event => {
  emitter.active = true              // set emitter to true (active) when pointer is down 
  update_emitter_from_pointer(event) // update the emitter's position and velocity based on the pointer input
})

// Pointer move event
canvas.addEventListener('pointermove', event => {
  if (!emitter.active) return        // only update the emitter if it's active
  update_emitter_from_pointer(event) // update position and velocity
})

// Pointer up event
const end_pointer = event => {
  emitter.active = false // set emitter to false (inactive) when pointer is up
  emitter.vx = 0         // reset x velocity to 0 when pointer is up
  emitter.vy = 0         // reset y velocity to 0 when pointer is up
}

// Listen for the pointer events
canvas.addEventListener('pointerup', end_pointer)
canvas.addEventListener('pointercancel', end_pointer)
canvas.addEventListener('pointerleave', end_pointer)

// Render pass
const render = await sg.render({
  shader: render_shader,
  data: [
    frame_uniform,
    resolution_uniform,
    state_buffer
  ],
  clearValue: [0, 0, 0, 1],
  onframe() {
    frame_uniform.value++
    resolution_uniform.value = [sg.width, sg.height] // keeps aspect ratio uniform across different screen ratios
    emitter_uniform.value = [
      emitter.x,
      emitter.y,
      emitter.vx,
      emitter.vy
    ]

    // Activation value of the emitter connected to the pointer
    emitter_active_uniform.value = [
      emitter.active ? 1 : 0
    ]

    speed_uniform.value = [saved_speed]                        // Update the speed uniform with the saved speed value from the slider
    noise_randomizer_uniform.value = [saved_noise_randomizer]  // Update the noise randomizer uniform with the saved value from the slider
  },
  count: num_particles,
  blend: true
})

// Compute
const dispatch_count = Math.ceil(num_particles / 64)

const compute = sg.compute({
  shader: compute_shader,
  data: [
    frame_uniform,
    resolution_uniform,
    emitter_uniform,
    emitter_active_uniform,
    speed_uniform,
    noise_randomizer_uniform,
    state_buffer
  ],
  dispatchCount: [dispatch_count, 1, 1]
})

sg.run(compute, render)