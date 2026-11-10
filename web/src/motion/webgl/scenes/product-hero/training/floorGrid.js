import { Color, Float32BufferAttribute, GridHelper, LineSegments, ShaderMaterial } from 'three'
import { valueNoise3D } from '../../../shaders/noise.js'
const GRID_SIZE = 20
const GRID_DIVISIONS = 40
const GRID_STEP = GRID_SIZE / GRID_DIVISIONS
const vertexShader = /* glsl */ `
  attribute float aParallelZ;

  varying vec2 vGridPosition;
  varying float vParallelZ;

  void main() {
    vGridPosition = (modelMatrix * vec4(position, 1.0)).xz;
    vParallelZ = aParallelZ;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragmentShader = /* glsl */ `
  uniform vec3 uGridColor;
  uniform float uTime;
  uniform float uDarkness;
  uniform float uSpeed;
  uniform float uNoiseFrequency;
  uniform float uThreshold;

  varying vec2 vGridPosition;
  varying float vParallelZ;

  ${valueNoise3D}

  void main() {
    // Scrolling the noise along +Z makes the dark impulses travel toward -Z.
    vec2 noisePosition = vec2(vGridPosition.x, vGridPosition.y + uTime * uSpeed) * uNoiseFrequency;
    float impulse = smoothstep(uThreshold - 0.08, uThreshold + 0.08, valueNoise(vec3(noisePosition, 0.0)));
    gl_FragColor = vec4(uGridColor * (1.0 - impulse * uDarkness * vParallelZ), 0.45);
    #include <colorspace_fragment>
  }
`
/**
 * Floor line grid that scrolls toward +X (with the data flow), while dark
 * impulses run along the lines parallel to Z.
 */
export function createFloorGrid(scene, gui) {
	const parameters = { scrollSpeed: 1.05 }
	const uniforms = {
		uGridColor: { value: new Color('#C7D4C4') },
		uTime: { value: 0 },
		uDarkness: { value: 0.85 },
		uSpeed: { value: 2.05 },
		uNoiseFrequency: { value: 2.55 },
		uThreshold: { value: 0.75 },
	}
	const helper = new GridHelper(GRID_SIZE, GRID_DIVISIONS)
	helper.material.dispose()
	const position = helper.geometry.getAttribute('position')
	const parallelZ = Array.from({ length: position.count }, (_, vertex) => {
		const first = vertex - (vertex % 2)
		return Number(position.getZ(first) !== position.getZ(first + 1))
	})
	helper.geometry.setAttribute('aParallelZ', new Float32BufferAttribute(parallelZ, 1))
	const grid = new LineSegments(
		helper.geometry,
		new ShaderMaterial({
			uniforms,
			vertexShader,
			fragmentShader,
			transparent: true,
			depthWrite: false,
		}),
	)
	grid.position.y = -0.501
	scene.add(grid)
	gui.addBinding(uniforms.uDarkness, 'value', {
		label: 'Impulse darkness',
		min: 0,
		max: 1,
		step: 0.01,
	})
	gui.addBinding(uniforms.uSpeed, 'value', { label: 'Impulse speed', min: 0, max: 5, step: 0.05 })
	gui.addBinding(uniforms.uNoiseFrequency, 'value', {
		label: 'Noise frequency',
		min: 0.1,
		max: 4,
		step: 0.05,
	})
	gui.addBinding(uniforms.uThreshold, 'value', { label: 'Threshold', min: 0, max: 1, step: 0.01 })
	gui.addBinding(parameters, 'scrollSpeed', { label: 'Grid speed X', min: 0, max: 2, step: 0.01 })
	return {
		update(delta, elapsed) {
			uniforms.uTime.value = elapsed
			// Wrapping by one grid step makes the scroll seamless.
			grid.position.x = (grid.position.x + delta * parameters.scrollSpeed) % GRID_STEP
		},
	}
}
