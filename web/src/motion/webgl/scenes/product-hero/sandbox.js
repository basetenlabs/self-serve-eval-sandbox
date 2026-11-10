import {
	BoxGeometry,
	Color,
	DynamicDrawUsage,
	InstancedBufferAttribute,
	InstancedMesh,
	Matrix4,
	ShaderMaterial,
} from '../../../lib/three.js'
import { pointerOnGridFace } from '../../objects/productCube.js'
import { DARK_COLOR, getProduct, parseFacePattern } from '../../palette.js'
import { aastep, faceGrid } from '../../shaders/common.js'
import { valueNoise3D } from '../../shaders/noise.js'
import { shuffle } from '../../utils/random.js'
import { createHeroProductCube, defineProductHeroScene } from './shared.js'
const GRID_SIDE = 9
const CELL_COUNT = GRID_SIDE * GRID_SIDE
const CENTER_CELL = Math.floor(CELL_COUNT / 2)
const GRID_HALF = Math.floor(GRID_SIDE / 2)
const GRID_SPACING = 1.2
/** Sandbox tint: top faces of the floor cubes and grid cells of the hero cube. */
const GRID_TOP_COLOR = '#FFEDC4'
const SWAP_LOWER_DISTANCE = 1.25
/** Max random start delay of each pair inside a swap round, in seconds. */
const SWAP_STAGGER = 0.45
const smoothstep01 = (value) => {
	const t = Math.min(Math.max(value, 0), 1)
	return t * t * (3 - 2 * t)
}
/**
 * Picks random, non-overlapping pairs of edge-adjacent cells (never the
 * center one) by bipartite matching on the checkerboard coloring, then keeps
 * `density` of the maximum and balances swaps along X and Z.
 */
function createCellPairs(density) {
	if (density <= 0) {
		return []
	}
	const matchOf = new Int32Array(CELL_COUNT).fill(-1)
	const visited = new Uint8Array(CELL_COUNT)
	const neighboursOf = (cell) => {
		const x = cell % GRID_SIDE
		const z = Math.floor(cell / GRID_SIDE)
		return [
			x > 0 && cell - 1,
			x < GRID_SIDE - 1 && cell + 1,
			z > 0 && cell - GRID_SIDE,
			z < GRID_SIDE - 1 && cell + GRID_SIDE,
		].filter((neighbour) => neighbour !== false && neighbour !== CENTER_CELL)
	}
	// Kuhn's augmenting path: try to match `cell` with a free (or re-matchable) neighbour.
	function match(cell) {
		for (const neighbour of shuffle(neighboursOf(cell))) {
			if (visited[neighbour]) {
				continue
			}
			visited[neighbour] = 1
			if (matchOf[neighbour] === -1 || match(matchOf[neighbour])) {
				matchOf[neighbour] = cell
				return true
			}
		}
		return false
	}
	const evenCells = Array.from({ length: CELL_COUNT }, (_, cell) => cell).filter(
		(cell) => cell !== CENTER_CELL && ((cell % GRID_SIDE) + Math.floor(cell / GRID_SIDE)) % 2 === 0,
	)
	for (const cell of shuffle(evenCells)) {
		visited.fill(0)
		match(cell)
	}
	const alongX = []
	const alongZ = []
	matchOf.forEach((other, cell) => {
		if (other >= 0) {
			const pair = Math.random() < 0.5 ? [cell, other] : [other, cell]
			;(Math.abs(cell - other) === 1 ? alongX : alongZ).push(pair)
		}
	})
	shuffle(alongX)
	shuffle(alongZ)
	const target = Math.round((Math.min(density, 1) * (CELL_COUNT - 1)) / 2)
	const preferredX = Math.floor(target / 2) + (Math.random() < 0.5 ? target % 2 : 0)
	const pairs = alongX.splice(0, preferredX)
	pairs.push(...alongZ.splice(0, target - pairs.length))
	pairs.push(...alongX.splice(0, target - pairs.length))
	pairs.push(...alongZ.splice(0, target - pairs.length))
	return shuffle(pairs)
}
const gridVertexShader = /* glsl */ `
  attribute vec2 aGridPosition;

  uniform float uOscillationTime;
  uniform float uOscillationFrequency;
  uniform float uOscillationAmplitude;

  varying vec2 vUv;
  varying vec3 vObjectNormal;
  varying vec2 vGridPosition;
  varying float vGridRotation;

  void main() {
    vUv = uv;
    vObjectNormal = normal;
    vGridPosition = aGridPosition;
    // Each cube shows its top pattern rotated by 0, 90 or 180 degrees.
    vGridRotation = floor(fract(sin(dot(aGridPosition + vec2(17.0, 31.0), vec2(127.1, 311.7))) * 43758.5453) * 3.0);

    // Gentle bobbing wave; the cube under the hero cube stays still.
    float bob = sin(uOscillationTime * uOscillationFrequency + aGridPosition.x * 0.7 + aGridPosition.y * 0.5)
      * uOscillationAmplitude
      * step(0.5, length(aGridPosition));

    gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position + vec3(0.0, bob, 0.0), 1.0);
  }
`
const gridFragmentShader = /* glsl */ `
  uniform vec3 uTopColor;
  uniform vec3 uSideColor;
  uniform vec3 uDarkColor;
  uniform int uPatternMask;
  uniform float uGridTime;
  uniform float uNoiseFrequency;
  uniform float uNoiseAmplitude;

  varying vec2 vUv;
  varying vec3 vObjectNormal;
  varying vec2 vGridPosition;
  varying float vGridRotation;

  ${valueNoise3D}
  ${aastep}
  ${faceGrid}

  void main() {
    vec3 color = uSideColor;

    if (vObjectNormal.y > 0.5) {
      vec2 uv = vGridRotation > 1.5 ? 1.0 - vUv : vGridRotation > 0.5 ? vec2(1.0 - vUv.y, vUv.x) : vUv;
      vec2 cell = faceGridCell(uv);
      // Squares breathe between 10% and 50% of their size.
      float noise = valueNoise(vec3(vGridPosition * 5.0 + cell, uGridTime) * uNoiseFrequency);
      float border = faceGridBorder(uv, 0.5 - 0.4 * uNoiseAmplitude * noise);
      color = mix(uSideColor, uTopColor, border);
      color = mix(color, uDarkColor, patternHole(cell, uPatternMask) * (1.0 - border));
    }
    else if (vObjectNormal.x < -0.5) {
      color = mix(uSideColor, vec3(1.0), 0.18);
    }

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`
/**
 * Sandbox (yellow): the hero cube floats over a 9×9 floor of cubes that keep swapping places.
 * @param {import('./shared.js').ProductHeroOptions} [options]
 */
export function createSandboxHeroScene({
	product = getProduct('sandbox'),
	videoUrl,
	zoom,
	trailFade,
} = {}) {
	return defineProductHeroScene({
		zoom,
		name: 'Product Hero · Sandbox',
		create(context) {
			const { scene, pointer, gui } = context
			scene.background = new Color('#F9F8F4')
			const parameters = {
				noiseSpeed: 1,
				oscillationSpeed: 1,
				swapDensity: 0.225,
				swapDuration: 1.2,
				swapPause: 0.5,
			}
			const gridUniforms = {
				uTopColor: { value: new Color(GRID_TOP_COLOR) },
				uSideColor: { value: new Color(product.color) },
				uDarkColor: { value: new Color(DARK_COLOR) },
				uPatternMask: { value: parseFacePattern(product.pattern) },
				uGridTime: { value: 0 },
				uNoiseFrequency: { value: 0.88 },
				uNoiseAmplitude: { value: 1 },
				uOscillationTime: { value: 0 },
				uOscillationFrequency: { value: 2.8 },
				uOscillationAmplitude: { value: 0.04 },
			}
			const geometry = new BoxGeometry()
			const grid = new InstancedMesh(
				geometry,
				new ShaderMaterial({
					uniforms: gridUniforms,
					vertexShader: gridVertexShader,
					fragmentShader: gridFragmentShader,
				}),
				CELL_COUNT,
			)
			const gridPositions = new Float32Array(CELL_COUNT * 2)
			/** Which instance currently sits in each cell (cubes keep their identity while moving). */
			const instanceAtCell = Int32Array.from({ length: CELL_COUNT }, (_, cell) => cell)
			/** Integer grid coordinates, centered on the hero cube. */
			const cellCoords = (cell) => [
				(cell % GRID_SIDE) - GRID_HALF,
				Math.floor(cell / GRID_SIDE) - GRID_HALF,
			]
			const cellPosition = (cell) => {
				const [x, z] = cellCoords(cell)
				return { x: x * GRID_SPACING, z: z * GRID_SPACING }
			}
			const matrix = new Matrix4()
			const placeInstance = (instance, x, y, z) =>
				grid.setMatrixAt(instance, matrix.makeTranslation(x, y, z))
			for (let cell = 0; cell < CELL_COUNT; cell += 1) {
				const { x, z } = cellPosition(cell)
				placeInstance(cell, x, -1, z)
				gridPositions.set(cellCoords(cell), cell * 2)
			}
			geometry.setAttribute('aGridPosition', new InstancedBufferAttribute(gridPositions, 2))
			grid.instanceMatrix.setUsage(DynamicDrawUsage)
			grid.frustumCulled = false
			scene.add(grid)
			const cube = createHeroProductCube(context, {
				product,
				gridCellColor: GRID_TOP_COLOR,
				videoUrl,
				trailFade,
			})
			const squaresFolder = gui.addFolder({ title: 'Grid squares' })
			squaresFolder.addBinding(gridUniforms.uNoiseFrequency, 'value', {
				label: 'Noise frequency',
				min: 0.05,
				max: 2,
				step: 0.01,
			})
			squaresFolder.addBinding(gridUniforms.uNoiseAmplitude, 'value', {
				label: 'Noise amplitude',
				min: 0,
				max: 1,
				step: 0.01,
			})
			squaresFolder.addBinding(parameters, 'noiseSpeed', {
				label: 'Speed',
				min: 0,
				max: 4,
				step: 0.01,
			})
			const oscillationFolder = gui.addFolder({ title: 'Cube oscillation' })
			oscillationFolder.addBinding(gridUniforms.uOscillationFrequency, 'value', {
				label: 'Frequency',
				min: 0,
				max: 4,
				step: 0.01,
			})
			oscillationFolder.addBinding(gridUniforms.uOscillationAmplitude, 'value', {
				label: 'Amplitude',
				min: 0,
				max: 0.2,
				step: 0.005,
			})
			oscillationFolder.addBinding(parameters, 'oscillationSpeed', {
				label: 'Speed',
				min: 0,
				max: 4,
				step: 0.01,
			})
			const swapFolder = gui.addFolder({ title: 'Cube swaps' })
			swapFolder.addBinding(parameters, 'swapDensity', {
				label: 'Density',
				min: 0,
				max: 1,
				step: 0.025,
			})
			swapFolder.addBinding(parameters, 'swapDuration', {
				label: 'Duration (s)',
				min: 0.4,
				max: 4,
				step: 0.05,
			})
			swapFolder.addBinding(parameters, 'swapPause', {
				label: 'Pause (s)',
				min: 0,
				max: 5,
				step: 0.05,
			})
			let swapRound = null
			let swapRoundElapsed = 0
			let swapRoundDuration = parameters.swapDuration
			let nextSwapRoundDelay = parameters.swapPause
			/**
			 * Swap rounds: every pair animates at once (with a random delay). The first
			 * cube of a pair dips down, both slide past each other, then it rises back.
			 */
			function updateSwaps(delta) {
				if (!swapRound) {
					nextSwapRoundDelay -= delta
					if (nextSwapRoundDelay <= 0) {
						swapRound = createCellPairs(parameters.swapDensity).map((cells) => ({
							cells,
							instances: [instanceAtCell[cells[0]], instanceAtCell[cells[1]]],
							delay: Math.random() * SWAP_STAGGER,
							done: false,
						}))
						swapRoundElapsed = 0
						swapRoundDuration = parameters.swapDuration
						nextSwapRoundDelay = parameters.swapPause
						if (swapRound.length === 0) {
							swapRound = null
						}
					}
					return
				}
				swapRoundElapsed += delta
				for (const pair of swapRound) {
					const progress = (swapRoundElapsed - pair.delay) / swapRoundDuration
					if (pair.done || progress < 0) {
						continue
					}
					const first = cellPosition(pair.cells[0])
					const second = cellPosition(pair.cells[1])
					const dip = smoothstep01(progress / 0.28) - smoothstep01((progress - 0.72) / 0.28)
					const slide = smoothstep01((progress - 0.28) / 0.44)
					placeInstance(
						pair.instances[0],
						first.x + (second.x - first.x) * slide,
						-1 - SWAP_LOWER_DISTANCE * dip,
						first.z + (second.z - first.z) * slide,
					)
					placeInstance(
						pair.instances[1],
						second.x + (first.x - second.x) * slide,
						-1,
						second.z + (first.z - second.z) * slide,
					)
					if (progress >= 1) {
						instanceAtCell[pair.cells[0]] = pair.instances[1]
						instanceAtCell[pair.cells[1]] = pair.instances[0]
						pair.done = true
					}
				}
				grid.instanceMatrix.needsUpdate = true
				if (swapRound.every((pair) => pair.done)) {
					swapRound = null
				}
			}
			return {
				update(frame) {
					updateSwaps(frame.delta)
					gridUniforms.uGridTime.value += frame.delta * parameters.noiseSpeed
					gridUniforms.uOscillationTime.value += frame.delta * parameters.oscillationSpeed
					cube.update(frame, pointerOnGridFace(pointer, cube.mesh))
				},
				dispose: cube.dispose,
			}
		},
	})
}
/** Sandbox hero with the default look from `PRODUCTS`. */
export const sandboxHeroScene = createSandboxHeroScene()
