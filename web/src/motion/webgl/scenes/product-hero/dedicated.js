import {
	BoxGeometry,
	Color,
	InstancedBufferAttribute,
	InstancedMesh,
	Matrix4,
	Mesh,
	PlaneGeometry,
	ShaderMaterial,
	Vector2,
	Vector3,
} from 'three'
import { pointerOnGridFace } from '../../objects/productCube.js'
import { getProduct } from '../../palette.js'
import { perlinNoise3D, simplexNoise2D } from '../../shaders/noise.js'
import { shuffle } from '../../utils/random.js'
import { createHeroProductCube, defineProductHeroScene } from './shared.js'
const CUBE_SPACING = 7 / 5
const BACKGROUND_COLOR = '#ECF6EA'
const CUBE_GRID_CELL_COLOR = '#D9F8D3'
const FLOOR_LINE_COLOR = '#BFDDBD'
const OUTLINE_WIDTH = 0.0025
/** Cluster layers alive at once: a layer is recycled when it reaches level -LAYER_COUNT. */
const LAYER_COUNT = 4
/**
 * Ground rectangle laid out with cells, in screen-aligned coordinates: `u`
 * along the frame width, `v` away from the camera. The isometric camera sees a
 * layer `h` lower `h · √2` further back, so the far edge follows the sinking depth.
 */
const FIELD_HALF_WIDTH = 3.4
const FIELD_NEAR = -1.6
/** Far edge seen by the top layer. */
const FIELD_FAR_AT_GROUND = 2.6
/** Bottom of the hero cube: the top layer stands on the same ground. */
const GROUND_Y = -0.5
/** Fraction of a glow's lifetime spent fading in. */
const GLOW_ATTACK = 0.2
const NEIGHBOURS_4 = [
	[1, 0],
	[-1, 0],
	[0, 1],
	[0, -1],
]
const NEIGHBOURS_8 = [...NEIGHBOURS_4, [1, 1], [1, -1], [-1, 1], [-1, -1]]
/** Cells covered by a big cube, from its first cell. */
const BLOCK_2X2 = [
	[0, 0],
	[1, 0],
	[0, 1],
	[1, 1],
]
/** The cells every layer is laid out on, minus the space around the hero cube. */
function createFieldCells({ divisions, clearance }, layerSpacing) {
	const spacing = CUBE_SPACING / divisions
	const clearHalfSize = CUBE_SPACING / 2 + clearance * spacing
	// With an even number of divisions, cells straddle the hero cell center.
	const offset = divisions % 2 === 0 ? 0.5 : 0
	const far = FIELD_FAR_AT_GROUND + LAYER_COUNT * layerSpacing * Math.SQRT2
	const half = Math.ceil((FIELD_HALF_WIDTH + far) / Math.SQRT2 / spacing)
	const cells = new Map()
	for (let i = -half; i <= half; i += 1) {
		for (let j = -half; j <= half; j += 1) {
			const x = (i + offset) * spacing
			const z = (j + offset) * spacing
			const u = (x + z) / Math.SQRT2
			const v = (x - z) / Math.SQRT2
			if (
				Math.abs(u) <= FIELD_HALF_WIDTH &&
				v >= FIELD_NEAR &&
				v <= far &&
				Math.max(Math.abs(x), Math.abs(z)) >= clearHalfSize
			) {
				cells.set(`${i},${j}`, { key: `${i},${j}`, i, j, x, z })
			}
		}
	}
	return cells
}
/**
 * Splits the field cells into compact clusters (Eden growth from random seeds)
 * at least one empty cell apart, then fills each cell with a stack of cubes
 * (lower near the hero cube) or merges 2×2 blocks of cells into big cubes.
 */
function createClusterLayout(cells, options) {
	const spacing = CUBE_SPACING / options.divisions
	// Same size-to-spacing ratio as hero-sized cubes.
	const cubeSize = spacing / CUBE_SPACING
	const clearHalfSize = CUBE_SPACING / 2 + options.clearance * spacing
	/** Cell key → index of the cluster that owns it. */
	const owners = new Map()
	const canTake = ({ key, i, j }, cluster) =>
		!owners.has(key) &&
		NEIGHBOURS_8.every(([di, dj]) => (owners.get(`${i + di},${j + dj}`) ?? cluster) === cluster)
	const grownClusters = []
	const minSize = Math.max(options.minClusterSize, 1)
	const maxSize = Math.max(options.maxClusterSize, minSize)
	let owned = 0
	for (const seed of shuffle([...cells.values()])) {
		if (owned >= options.density * cells.size) {
			break
		}
		const cluster = grownClusters.length
		const size = minSize + Math.floor(Math.random() * (maxSize - minSize + 1))
		const grown = []
		// Duplicates stay in: cells touching more of the cluster are likelier picks, which keeps it compact.
		const frontier = [seed]
		while (grown.length < size && frontier.length > 0) {
			const cell = frontier.splice(Math.floor(Math.random() * frontier.length), 1)[0]
			if (!canTake(cell, cluster)) {
				continue
			}
			owners.set(cell.key, cluster)
			grown.push(cell)
			NEIGHBOURS_4.forEach(([di, dj]) => {
				const neighbour = cells.get(`${cell.i + di},${cell.j + dj}`)
				if (neighbour) {
					frontier.push(neighbour)
				}
			})
		}
		if (grown.length > 0) {
			owned += grown.length
			grownClusters.push(grown)
		}
	}
	const matrices = []
	/** Per cube: order of its cell in the cluster growth, stack level. */
	const orders = []
	const addCube = (x, z, size, level, order) => {
		matrices.push(
			new Matrix4()
				.makeScale(size, size, size)
				.setPosition(x, GROUND_Y + size / 2 + level * spacing, z),
		)
		orders.push(order, level)
	}
	const clusters = grownClusters.map((grown) => {
		const seed = grown[0]
		const distance = Math.hypot(seed.x, seed.z)
		const heightCap = Math.min(
			options.maxStack,
			1 + Math.floor((distance - clearHalfSize) / CUBE_SPACING),
		)
		const height = 1 + Math.floor(Math.random() * Math.max(heightCap, 1))
		const firstInstance = matrices.length
		const orderOf = new Map(grown.map(({ key }, order) => [key, order]))
		const merged = new Set()
		grown.forEach(({ i, j, x, z }) => {
			const block = BLOCK_2X2.map(([di, dj]) => `${i + di},${j + dj}`)
			if (
				block.every((key) => orderOf.has(key) && !merged.has(key)) &&
				Math.random() < options.bigCubeChance
			) {
				block.forEach((key) => merged.add(key))
				const order = Math.min(...block.map((key) => orderOf.get(key)))
				addCube(x + spacing / 2, z + spacing / 2, spacing + cubeSize, 0, order)
			}
		})
		grown.forEach(({ key, x, z }, order) => {
			if (merged.has(key)) {
				return
			}
			const levels = 1 + Math.floor(Math.random() * height)
			for (let level = 0; level < levels; level += 1) {
				addCube(x, z, cubeSize, level, order)
			}
		})
		return { distance, firstInstance, instanceCount: matrices.length - firstInstance }
	})
	return { matrices, orders, clusters }
}
const floorShaders = {
	vertexShader: /* glsl */ `
    varying vec2 vWorldXZ;

    void main() {
      vec4 worldPosition = modelMatrix * vec4(position, 1.0);
      vWorldXZ = worldPosition.xz;
      gl_Position = projectionMatrix * viewMatrix * worldPosition;
    }
  `,
	fragmentShader: /* glsl */ `
    uniform vec3 uLineColor;
    uniform float uLineOpacity;
    uniform float uGridSpacing;
    uniform float uTime;
    uniform float uWaveStart;
    uniform float uWaveSpeed;
    uniform float uWaveInterval;
    uniform float uWaveWidth;
    uniform vec3 uWaveColor;

    varying vec2 vWorldXZ;

    void main() {
      vec2 gridPosition = vWorldXZ / uGridSpacing;
      vec2 lines = 1.0 - smoothstep(vec2(0.0), max(fwidth(gridPosition), 0.0001) * 1.25, abs(fract(gridPosition) - 0.5));
      float line = max(lines.x, lines.y);

      // A wave front leaves the center every uWaveInterval (also before the scene started, for the prefilled layers)
      // and lights up the lines: sharp leading edge, fading out behind.
      float frontSpacing = uWaveInterval * uWaveSpeed;
      float sinceFront = mod((uTime - uWaveStart) * uWaveSpeed - length(vWorldXZ), frontSpacing);
      float wave = max(
        1.0 - smoothstep(0.0, uWaveWidth, sinceFront),
        smoothstep(-0.05, 0.0, sinceFront - frontSpacing)
      );

      gl_FragColor = vec4(mix(uLineColor, uWaveColor, wave), line * max(uLineOpacity, wave));
      #include <colorspace_fragment>
    }
  `,
}
/** Flat fill with a thin outline on every face edge. */
const outlineChunk = /* glsl */ `
  float edgeOutline(vec2 uv, float width) {
    vec2 edgeDistance = min(uv, 1.0 - uv);
    float edge = min(edgeDistance.x, edgeDistance.y);
    return 1.0 - smoothstep(width, width + max(fwidth(edge), 0.0001), edge);
  }
`
const clusterShaders = {
	vertexShader: /* glsl */ `
    uniform float uTime;
    uniform float uGridSpacing;
    uniform float uCellStagger;
    uniform float uStackStagger;
    uniform float uSproutDuration;
    uniform float uOvershoot;
    uniform float uGlowDuration;
    uniform float uWobbleTime;
    uniform float uWobbleFrequency;
    uniform float uScaleWobble;
    uniform float uBob;
    /** Levels the layer has receded from the ground. */
    uniform float uDepth;
    /** Depth range over which cubes turn grey. */
    uniform float uGreyStart;
    uniform float uGreyEnd;
    /** Depth where layers start fading out; they are gone at level -LAYER_COUNT. */
    uniform float uFadeStart;
    /** Per layer, so each one breathes and fades differently. */
    uniform float uSeed;
    /** Eased pointer, in NDC, and how much it counts (0 once it leaves the canvas). */
    uniform vec2 uPointer;
    uniform float uPointerStrength;
    /** Scale of the stacks right under the pointer, back to 1 at uPointerRadius (CSS px). */
    uniform float uPointerScale;
    uniform float uPointerRadius;
    /** Canvas size in CSS px. */
    uniform vec2 uViewport;

    /** Sprout start of the cube's cluster, in scene time. */
    attribute float aSprout;
    /** Order of the cube's cell in its cluster growth, stack level. */
    attribute vec2 aOrder;

    varying vec2 vUv;
    varying vec2 vCellCenter;
    varying float vScale;
    varying float vGlow;
    varying float vGrey;
    varying float vFade;

    ${perlinNoise3D}

    float easeOutBack(float t, float overshoot) {
      float u = t - 1.0;
      return 1.0 + (overshoot + 1.0) * u * u * u + overshoot * u * u;
    }

    /** Quick fade in, slower fade out, over age 0..1. */
    float glowCurve(float age) {
      float glow = clamp(min(age / ${GLOW_ATTACK.toFixed(3)}, (1.0 - age) / ${(1 - GLOW_ATTACK).toFixed(3)}), 0.0, 1.0);
      return glow * glow * (3.0 - 2.0 * glow);
    }

    void main() {
      // Cells sprout in growth order, bottom up.
      float sproutTime = aSprout + aOrder.x * uCellStagger + aOrder.y * uStackStagger;
      vec3 center = instanceMatrix[3].xyz;

      // Receding past uFadeStart, the layer fades into the background and its stacks vanish one by one.
      float fade = clamp((uDepth - uFadeStart) / max(${LAYER_COUNT.toFixed(1)} - uFadeStart, 0.001), 0.0, 1.0);
      float vanishAt = 0.7 * fract(sin(dot(center.xz + uSeed, vec2(127.1, 311.7))) * 43758.5453);
      float vanish = smoothstep(vanishAt, vanishAt + 0.3, fade);

      // Breathing and floating: noise over the ground, so neighbouring cubes (and stacks) move together.
      vec2 noiseCoord = center.xz * uWobbleFrequency + uSeed;
      float wobble = perlinNoise(vec3(noiseCoord, uWobbleTime));
      float bob = perlinNoise(vec3(noiseCoord + 17.3, uWobbleTime));

      // Stacks near the pointer grow with a cubic falloff from it, measured on screen from their base.
      float levelSpacing = length(instanceMatrix[0].xyz) * uGridSpacing;
      vec4 stackBase = projectionMatrix * modelViewMatrix * vec4(center.x, center.y - aOrder.y * levelSpacing, center.z, 1.0);
      float pointerDistance = length((stackBase.xy / stackBase.w - uPointer) * 0.5 * uViewport);
      float closeness = 1.0 - clamp(pointerDistance / uPointerRadius, 0.0, 1.0);
      float hover = 1.0 + (uPointerScale - 1.0) * uPointerStrength * closeness * closeness;

      float growth = easeOutBack(clamp((uTime - sproutTime) / uSproutDuration, 0.0, 1.0), uOvershoot)
        * (1.0 + uScaleWobble * wobble)
        * (1.0 - vanish)
        * hover;

      vUv = uv;
      vCellCenter = center.xz / uGridSpacing;
      vScale = length(instanceMatrix[0].xyz) * max(growth, 0.001);
      vGlow = glowCurve((uTime - sproutTime) / uGlowDuration);
      // Receding layers turn grey, leaving the green to the newest one.
      vGrey = smoothstep(uGreyStart, uGreyEnd, uDepth);
      vFade = fade;

      // Grows out of the middle of its bottom face.
      vec3 grown = vec3(position.x, position.y + 0.5, position.z) * growth - vec3(0.0, 0.5, 0.0);
      vec4 instancePosition = instanceMatrix * vec4(grown, 1.0);
      // Upper levels rise with the hover scale, so the whole stack grows from the ground.
      instancePosition.y += uBob * bob + aOrder.y * levelSpacing * (hover - 1.0);
      gl_Position = projectionMatrix * modelViewMatrix * instancePosition;
    }
  `,
	fragmentShader: /* glsl */ `
    uniform vec3 uBaseColor;
    uniform vec3 uOutlineColor;
    uniform float uOutlineWidth;
    uniform float uNoiseTime;
    uniform float uNoiseScale;
    uniform float uNoiseIntensity;
    uniform vec3 uGlowColor;
    uniform vec3 uGlowOutlineColor;
    uniform vec3 uSunkFillColor;
    uniform vec3 uSunkOutlineColor;
    uniform vec3 uBackgroundColor;

    varying vec2 vUv;
    varying vec2 vCellCenter;
    varying float vScale;
    varying float vGlow;
    varying float vGrey;
    varying float vFade;

    ${simplexNoise2D}
    ${outlineChunk}

    void main() {
      float noise = snoise(vCellCenter * uNoiseScale + vec2(1.0, 0.7) * uNoiseTime) * 0.5 + 0.5;
      vec3 baseOutline = mix(uOutlineColor, uSunkOutlineColor, vGrey) * (1.0 - noise * uNoiseIntensity);
      vec3 outlineColor = mix(baseOutline, uGlowOutlineColor, vGlow);
      vec3 fill = mix(mix(uBaseColor, uSunkFillColor, vGrey), uGlowColor, vGlow);
      vec3 color = mix(fill, outlineColor, edgeOutline(vUv, uOutlineWidth / vScale));
      gl_FragColor = vec4(mix(color, uBackgroundColor, vFade), 1.0);
      #include <colorspace_fragment>
    }
  `,
}
/**
 * Dedicated Inference (green): at a steady pace, a wave leaves the hero cube
 * and sprouts a layer of clusters on the ground, while every layer keeps
 * receding along the view direction (one level per wave) and turning grey.
 * The orthographic camera does not show the move, so layers stay put on screen.
 * Further back layers fade out, then come back on the ground with a new layout.
 */
export function createDedicatedHeroScene({
	product = getProduct('dedicated-inference'),
	videoUrl,
} = {}) {
	return defineProductHeroScene({
		name: 'Product Hero · Dedicated',
		create(context) {
			const { scene, camera, pointer, size, gui } = context
			scene.background = new Color(BACKGROUND_COLOR)
			const viewDirection = camera.getWorldDirection(new Vector3())
			/** Layout and timing parameters: a change restarts the animation. */
			const parameters = {
				introDelay: 0.4,
				/** Layers already grown when the scene starts, as if sprouted by earlier waves. */
				prefilledLayers: 2,
				waveSpeed: 1.5,
				waveInterval: 2.5,
				layerSpacing: CUBE_SPACING,
				sproutJitter: 0.4,
				divisions: 6,
				density: 0.3,
				minClusterSize: 4,
				maxClusterSize: 12,
				maxStack: 2,
				bigCubeChance: 0.3,
				clearance: 1,
				wobbleSpeed: 0.35,
				noiseSpeed: 0.45,
				/** How fast the eased pointer catches up with the real one (1/s). */
				pointerLerp: 8,
			}
			/** Shared by the floor and the clusters. */
			const waveUniforms = {
				uTime: { value: 0 },
				uWaveStart: { value: 0 },
				uWaveSpeed: { value: 1 },
				uWaveInterval: { value: 1 },
			}
			// Floor grid lines, just below the top layer.
			const floorUniforms = {
				...waveUniforms,
				uLineColor: { value: new Color(FLOOR_LINE_COLOR) },
				uLineOpacity: { value: 0.35 },
				uGridSpacing: { value: CUBE_SPACING },
				uWaveWidth: { value: 0.8 },
				uWaveColor: { value: new Color(product.color) },
			}
			const floor = new Mesh(
				new PlaneGeometry(200, 200),
				new ShaderMaterial({
					...floorShaders,
					uniforms: floorUniforms,
					transparent: true,
					depthWrite: false,
				}),
			)
			floor.rotation.x = -Math.PI / 2
			floor.position.y = -0.52
			scene.add(floor)
			const clusterUniforms = {
				uTime: waveUniforms.uTime,
				uGridSpacing: { value: CUBE_SPACING },
				uCellStagger: { value: 0.03 },
				uStackStagger: { value: 0.12 },
				uSproutDuration: { value: 0.6 },
				uOvershoot: { value: 1.6 },
				uGlowDuration: { value: 1.4 },
				uWobbleTime: { value: 0 },
				uWobbleFrequency: { value: 1.2 },
				uScaleWobble: { value: 0.12 },
				uBob: { value: 0.04 },
				uGreyStart: { value: 0.4 },
				uGreyEnd: { value: 1.2 },
				uFadeStart: { value: 2 },
				uBaseColor: { value: new Color(CUBE_GRID_CELL_COLOR) },
				uOutlineColor: { value: new Color(FLOOR_LINE_COLOR) },
				uOutlineWidth: { value: OUTLINE_WIDTH },
				uGlowColor: { value: new Color('#A5F2C9') },
				uGlowOutlineColor: { value: new Color(product.color) },
				uSunkFillColor: { value: new Color('#EBECEA') },
				uSunkOutlineColor: { value: new Color('#C6C9C5') },
				uPointer: { value: new Vector2() },
				uPointerStrength: { value: 0 },
				uPointerScale: { value: 0.6 },
				uPointerRadius: { value: 600 },
				uViewport: { value: new Vector2(size.width, size.height) },
				uBackgroundColor: { value: new Color(BACKGROUND_COLOR) },
				uNoiseTime: { value: 0 },
				uNoiseScale: { value: 0.96 },
				uNoiseIntensity: { value: 0.26 },
			}
			/** Scene time: restarts on replay. */
			let time = 0
			/** Last wave that sprouted a layer: replay sets it before the prefilled waves (negative indices). */
			let lastWave = -1
			let cells = new Map()
			let layers = []
			/** A pool layer, hidden until a wave sprouts it. Sized for the densest layout `cells` allows. */
			function createLayer() {
				const capacity = cells.size * parameters.maxStack
				const geometry = new BoxGeometry()
				const sprout = new InstancedBufferAttribute(new Float32Array(capacity), 1)
				const order = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
				geometry.setAttribute('aSprout', sprout)
				geometry.setAttribute('aOrder', order)
				const uniforms = { uDepth: { value: LAYER_COUNT }, uSeed: { value: 0 } }
				const material = new ShaderMaterial({
					...clusterShaders,
					uniforms: { ...clusterUniforms, ...uniforms },
				})
				const mesh = new InstancedMesh(geometry, material, capacity)
				mesh.count = 0
				mesh.visible = false
				mesh.frustumCulled = false
				scene.add(mesh)
				return { mesh, material, sprout, order, uniforms, wave: -Infinity }
			}
			/** Lays out new clusters on `layer` and sprouts them as the front of `wave` reaches them. */
			function sproutLayer(layer, wave) {
				const waveTime = parameters.introDelay + wave * parameters.waveInterval
				const layout = createClusterLayout(cells, parameters)
				layout.matrices.forEach((matrix, index) => layer.mesh.setMatrixAt(index, matrix))
				layer.order.copyArray(layout.orders)
				// Clusters sprout as the floor's wave front reaches them.
				layout.clusters.forEach(({ distance, firstInstance, instanceCount }) => {
					const sprout =
						waveTime + distance / parameters.waveSpeed + Math.random() * parameters.sproutJitter
					layer.sprout.array.fill(sprout, firstInstance, firstInstance + instanceCount)
				})
				layer.mesh.count = layout.matrices.length
				layer.mesh.instanceMatrix.needsUpdate = true
				layer.order.needsUpdate = true
				layer.sprout.needsUpdate = true
				layer.uniforms.uSeed.value = Math.random() * 100
				layer.wave = wave
			}
			/**
			 * Restarts with the current parameters. The first frame sprouts the
			 * prefilled layers from earlier waves, so they are already grown and sinking.
			 */
			function replay() {
				layers.forEach(({ mesh, material }) => {
					scene.remove(mesh)
					mesh.geometry.dispose()
					material.dispose()
					mesh.dispose()
				})
				time = 0
				lastWave = -1 - parameters.prefilledLayers
				waveUniforms.uWaveStart.value = parameters.introDelay
				waveUniforms.uWaveSpeed.value = parameters.waveSpeed
				waveUniforms.uWaveInterval.value = parameters.waveInterval
				cells = createFieldCells(parameters, parameters.layerSpacing)
				layers = Array.from({ length: LAYER_COUNT }, createLayer)
			}
			replay()
			const cube = createHeroProductCube(context, {
				product,
				gridCellColor: CUBE_GRID_CELL_COLOR,
				videoUrl,
			})
			gui.addButton({ title: 'Replay' }).on('click', replay)
			const wavesFolder = gui.addFolder({ title: 'Waves & layers' })
			wavesFolder
				.addBinding(parameters, 'introDelay', { label: 'Delay (s)', min: 0, max: 3, step: 0.05 })
				.on('change', replay)
			wavesFolder
				.addBinding(parameters, 'prefilledLayers', {
					label: 'Prefilled layers',
					min: 0,
					max: LAYER_COUNT - 1,
					step: 1,
				})
				.on('change', replay)
			wavesFolder
				.addBinding(parameters, 'waveSpeed', { label: 'Speed', min: 0.2, max: 5, step: 0.05 })
				.on('change', replay)
			wavesFolder
				.addBinding(parameters, 'waveInterval', {
					label: 'Interval (s)',
					min: 1,
					max: 12,
					step: 0.1,
				})
				.on('change', replay)
			wavesFolder
				.addBinding(parameters, 'layerSpacing', {
					label: 'Layer spacing',
					min: 0.3,
					max: 3,
					step: 0.05,
				})
				.on('change', replay)
			wavesFolder.addBinding(floorUniforms.uWaveWidth, 'value', {
				label: 'Highlight width',
				min: 0.05,
				max: 3,
				step: 0.05,
			})
			wavesFolder.addBinding(clusterUniforms.uGreyStart, 'value', {
				label: 'Grey from (levels)',
				min: 0,
				max: LAYER_COUNT,
				step: 0.05,
			})
			wavesFolder.addBinding(clusterUniforms.uGreyEnd, 'value', {
				label: 'Grey to (levels)',
				min: 0,
				max: LAYER_COUNT,
				step: 0.05,
			})
			wavesFolder.addBinding(clusterUniforms.uFadeStart, 'value', {
				label: 'Fade from (levels)',
				min: 0,
				max: LAYER_COUNT - 0.5,
				step: 0.05,
			})
			const wobbleFolder = gui.addFolder({ title: 'Wobble' })
			wobbleFolder.addBinding(clusterUniforms.uScaleWobble, 'value', {
				label: 'Scale (±)',
				min: 0,
				max: 0.4,
				step: 0.01,
			})
			wobbleFolder.addBinding(clusterUniforms.uBob, 'value', {
				label: 'Vertical (±)',
				min: 0,
				max: 0.3,
				step: 0.005,
			})
			wobbleFolder.addBinding(clusterUniforms.uWobbleFrequency, 'value', {
				label: 'Frequency',
				min: 0.05,
				max: 5,
				step: 0.05,
			})
			wobbleFolder.addBinding(parameters, 'wobbleSpeed', {
				label: 'Speed',
				min: 0,
				max: 2,
				step: 0.01,
			})
			const clustersFolder = gui.addFolder({ title: 'Clusters' })
			clustersFolder
				.addBinding(parameters, 'divisions', { label: 'Grain', min: 2, max: 8, step: 1 })
				.on('change', replay)
			clustersFolder
				.addBinding(parameters, 'density', { label: 'Density', min: 0.05, max: 1, step: 0.05 })
				.on('change', replay)
			clustersFolder
				.addBinding(parameters, 'minClusterSize', { label: 'Min size', min: 1, max: 40, step: 1 })
				.on('change', replay)
			clustersFolder
				.addBinding(parameters, 'maxClusterSize', { label: 'Max size', min: 1, max: 40, step: 1 })
				.on('change', replay)
			clustersFolder
				.addBinding(parameters, 'maxStack', { label: 'Max stack', min: 1, max: 5, step: 1 })
				.on('change', replay)
			clustersFolder
				.addBinding(parameters, 'bigCubeChance', { label: 'Big cubes', min: 0, max: 1, step: 0.05 })
				.on('change', replay)
			clustersFolder
				.addBinding(parameters, 'clearance', { label: 'Clearance', min: 0, max: 8, step: 1 })
				.on('change', replay)
			const sproutFolder = gui.addFolder({ title: 'Sprout' })
			sproutFolder
				.addBinding(parameters, 'sproutJitter', { label: 'Jitter (s)', min: 0, max: 3, step: 0.05 })
				.on('change', replay)
			sproutFolder.addBinding(clusterUniforms.uSproutDuration, 'value', {
				label: 'Duration (s)',
				min: 0.1,
				max: 3,
				step: 0.05,
			})
			sproutFolder.addBinding(clusterUniforms.uOvershoot, 'value', {
				label: 'Overshoot',
				min: 0,
				max: 4,
				step: 0.05,
			})
			sproutFolder.addBinding(clusterUniforms.uCellStagger, 'value', {
				label: 'Cell stagger (s)',
				min: 0,
				max: 0.3,
				step: 0.005,
			})
			sproutFolder.addBinding(clusterUniforms.uStackStagger, 'value', {
				label: 'Stack stagger (s)',
				min: 0,
				max: 0.5,
				step: 0.01,
			})
			sproutFolder.addBinding(clusterUniforms.uGlowDuration, 'value', {
				label: 'Glow (s)',
				min: 0.1,
				max: 5,
				step: 0.05,
			})
			const colorsFolder = gui.addFolder({ title: 'Cluster colors', expanded: false })
			const addColor = (label, uniform) => {
				const state = { color: `#${uniform.value.getHexString()}` }
				colorsFolder
					.addBinding(state, 'color', { label })
					.on('change', ({ value }) => uniform.value.set(value))
			}
			addColor('Fill', clusterUniforms.uBaseColor)
			addColor('Outline', clusterUniforms.uOutlineColor)
			addColor('Glow fill', clusterUniforms.uGlowColor)
			addColor('Glow outline', clusterUniforms.uGlowOutlineColor)
			addColor('Sunk fill', clusterUniforms.uSunkFillColor)
			addColor('Sunk outline', clusterUniforms.uSunkOutlineColor)
			colorsFolder.addBinding(clusterUniforms.uOutlineWidth, 'value', {
				label: 'Outline width',
				min: 0,
				max: 0.01,
				step: 0.0005,
			})
			const pointerFolder = gui.addFolder({ title: 'Pointer' })
			pointerFolder.addBinding(clusterUniforms.uPointerScale, 'value', {
				label: 'Scale under pointer',
				min: 0,
				max: 2,
				step: 0.01,
			})
			pointerFolder.addBinding(clusterUniforms.uPointerRadius, 'value', {
				label: 'Radius (px)',
				min: 20,
				max: 800,
				step: 10,
			})
			pointerFolder.addBinding(parameters, 'pointerLerp', {
				label: 'Lerp (1/s)',
				min: 1,
				max: 30,
				step: 0.5,
			})
			const noiseFolder = gui.addFolder({ title: 'Outline noise', expanded: false })
			noiseFolder.addBinding(clusterUniforms.uNoiseIntensity, 'value', {
				label: 'Intensity',
				min: 0,
				max: 0.5,
				step: 0.005,
			})
			noiseFolder.addBinding(clusterUniforms.uNoiseScale, 'value', {
				label: 'Frequency',
				min: 0.01,
				max: 1,
				step: 0.01,
			})
			noiseFolder.addBinding(parameters, 'noiseSpeed', {
				label: 'Speed',
				min: 0,
				max: 1,
				step: 0.01,
			})
			return {
				update(frame) {
					const { delta } = frame
					time += delta
					waveUniforms.uTime.value = time
					clusterUniforms.uWobbleTime.value += delta * parameters.wobbleSpeed
					clusterUniforms.uNoiseTime.value += delta * parameters.noiseSpeed
					// Frame-rate independent lerp towards the pointer; the effect eases out when it leaves the canvas.
					const pointerEase = 1 - Math.exp(-delta * parameters.pointerLerp)
					const { uPointer, uPointerStrength } = clusterUniforms
					uPointer.value.lerp(pointer.ndc, pointerEase)
					uPointerStrength.value +=
						((pointer.inside ? 1 : 0) - uPointerStrength.value) * pointerEase
					const { introDelay, waveInterval } = parameters
					const waves = (time - introDelay) / waveInterval
					// Each wave recycles the layer that sank out of sight (or one never used yet).
					for (; lastWave < Math.floor(waves); lastWave += 1) {
						sproutLayer(
							layers.reduce((oldest, layer) => (layer.wave < oldest.wave ? layer : oldest)),
							lastWave + 1,
						)
					}
					// Layers recede steadily, one level per wave interval, so the ground is clear when the next
					// wave leaves. The camera looks along (1, -1, -1): a level drops them by `layerSpacing`, like
					// sinking would, and whole levels keep their cubes on the grid.
					layers.forEach(({ mesh, uniforms, wave }) => {
						const depth = Math.min(waves - wave, LAYER_COUNT)
						uniforms.uDepth.value = depth
						mesh.position
							.copy(viewDirection)
							.multiplyScalar(depth * parameters.layerSpacing * Math.sqrt(3))
						mesh.visible = depth < LAYER_COUNT
					})
					cube.update(frame, pointerOnGridFace(pointer, cube.mesh))
				},
				resize({ width, height }) {
					clusterUniforms.uViewport.value.set(width, height)
				},
				dispose: cube.dispose,
			}
		},
	})
}
/** Dedicated Inference hero with the default look from `PRODUCTS`. */
export const dedicatedHeroScene = createDedicatedHeroScene()
