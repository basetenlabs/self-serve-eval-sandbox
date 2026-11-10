import {
	BoxGeometry,
	Color,
	DynamicDrawUsage,
	Euler,
	InstancedBufferAttribute,
	InstancedMesh,
	MathUtils,
	Matrix4,
	Plane,
	ShaderMaterial,
	Vector3,
} from 'three'
import { defineScene } from '../core/types.js'
const MAX_INSTANCES = 60
/** Per-instance hover colors, cycled: side faces / top and -X faces. */
const HOVER_COLORS = ['#009735', '#3DA6FF', '#D5700B', '#CDDCC7', '#B20EAE']
const LIGHT_HOVER_COLORS = ['#19E76E', '#D4EBFF', '#F4B23F', '#F1F7EF', '#FFA9FD']
/** Exponential easing rates (1/s) of the hover state: scale reaches 95% in 0.15s, color in 0.3s. */
const SCALE_DAMPING = -Math.log(0.05) / 0.15
const COLOR_DAMPING = SCALE_DAMPING / 2
const vertexShader = /* glsl */ `
  uniform float uGroupRotationX;
  uniform float uCursorX;
  uniform float uRepulsionThreshold;
  uniform float uRepulsionStrength;
  uniform float uRepulsionRotation;
  uniform float uHoverScale;
  uniform vec3 uBaseZColor;
  uniform vec3 uBaseYColor;
  uniform vec3 uBaseXPositiveColor;
  uniform vec3 uBaseXNegativeColor;
  uniform vec3 uHoverXPositiveColor;

  attribute vec3 aHoverColor;
  attribute vec3 aLightHoverColor;
  // x: hover scale, y: hover color, z: repulsion. Each 0..1, eased on the CPU.
  attribute vec3 aHoverState;

  varying vec3 vColor;

  mat3 rotationX(float angle) {
    float s = sin(angle);
    float c = cos(angle);
    return mat3(1.0, 0.0, 0.0, 0.0, c, s, 0.0, -s, c);
  }

  void main() {
    // Bricks near the cursor are pushed sideways and tilt; the tilt fades out
    // toward the repulsion threshold.
    float offset = instanceMatrix[3].x - uCursorX;
    float direction = clamp(offset / max(uRepulsionThreshold * 0.2, 0.0001), -1.0, 1.0);
    float envelope = 1.0 - smoothstep(0.0, 1.0, abs(clamp(offset / max(uRepulsionThreshold, 0.0001), -1.0, 1.0)));
    mat3 tilt = rotationX(min(aHoverState.z, envelope) * radians(uRepulsionRotation));

    vec4 instancePosition = instanceMatrix * vec4(tilt * (position * mix(1.0, uHoverScale, aHoverState.x)), 1.0);
    instancePosition.x += direction * aHoverState.z * uRepulsionStrength;
    instancePosition.xyz = rotationX(uGroupRotationX) * instancePosition.xyz;

    vec3 baseColor = uBaseZColor;
    vec3 hoverColor = aHoverColor;
    if (abs(normal.y) > 0.5) {
      baseColor = uBaseYColor;
      hoverColor = aLightHoverColor;
    }
    else if (normal.x > 0.5) {
      baseColor = uBaseXPositiveColor;
      hoverColor = uHoverXPositiveColor;
    }
    else if (normal.x < -0.5) {
      baseColor = uBaseXNegativeColor;
      hoverColor = aLightHoverColor;
    }

    vColor = mix(baseColor, hoverColor, aHoverState.y);
    gl_Position = projectionMatrix * viewMatrix * modelMatrix * instancePosition;
  }
`
const fragmentShader = /* glsl */ `
  varying vec3 vColor;

  void main() {
    gl_FragColor = vec4(vColor, 1.0);
    #include <colorspace_fragment>
  }
`
/**
 * A row of bricks along -X, each rotated a bit more around X, spinning as a
 * group. Bricks near the cursor grow, take a color and get pushed aside.
 */
export const bricksScene = defineScene({
	name: 'Bricks',
	camera: { type: 'orthographic', frustumHeight: 8, zoom: 2.55, position: [0, 0, 10] },
	create({ scene, camera, pointer, gui }) {
		const layout = {
			count: 25,
			spacing: 0.55,
			initialRotation: { x: 30, y: 33, z: 0 },
			rotationIncrementX: 12,
			offset: { x: 3.54, y: 0.34 },
		}
		const parameters = {
			speed: 18,
			threshold: 2.2,
			cursorLerp: 10,
		}
		const uniforms = {
			uGroupRotationX: { value: 0 },
			uCursorX: { value: 0 },
			uRepulsionThreshold: { value: 5.2 },
			uRepulsionStrength: { value: 0.24 },
			uRepulsionRotation: { value: 45 },
			uHoverScale: { value: 1.35 },
			uBaseZColor: { value: new Color('#CDDCC7') },
			uBaseYColor: { value: new Color('#F1F7EF') },
			uBaseXPositiveColor: { value: new Color('#CDDCC7') },
			uBaseXNegativeColor: { value: new Color('#000000') },
			uHoverXPositiveColor: { value: new Color('#000000') },
		}
		const geometry = new BoxGeometry(0.3, 0.6, 1.5)
		const hoverColors = new Float32Array(MAX_INSTANCES * 3)
		const lightHoverColors = new Float32Array(MAX_INSTANCES * 3)
		const color = new Color()
		for (let index = 0; index < MAX_INSTANCES; index += 1) {
			color.set(HOVER_COLORS[index % HOVER_COLORS.length]).toArray(hoverColors, index * 3)
			color
				.set(LIGHT_HOVER_COLORS[index % LIGHT_HOVER_COLORS.length])
				.toArray(lightHoverColors, index * 3)
		}
		const hoverState = new InstancedBufferAttribute(
			new Float32Array(MAX_INSTANCES * 3),
			3,
		).setUsage(DynamicDrawUsage)
		geometry.setAttribute('aHoverColor', new InstancedBufferAttribute(hoverColors, 3))
		geometry.setAttribute('aLightHoverColor', new InstancedBufferAttribute(lightHoverColors, 3))
		geometry.setAttribute('aHoverState', hoverState)
		const bricks = new InstancedMesh(
			geometry,
			new ShaderMaterial({ uniforms, vertexShader, fragmentShader }),
			MAX_INSTANCES,
		)
		bricks.frustumCulled = false
		scene.add(bricks)
		const matrix = new Matrix4()
		const rotation = new Euler()
		function updateLayout() {
			const { x, y, z } = layout.initialRotation
			bricks.count = layout.count
			bricks.position.set(layout.offset.x, layout.offset.y, 0)
			bricks.updateMatrixWorld()
			for (let index = 0; index < layout.count; index += 1) {
				rotation.set(
					MathUtils.degToRad(x + index * layout.rotationIncrementX),
					MathUtils.degToRad(y),
					MathUtils.degToRad(z),
				)
				bricks.setMatrixAt(
					index,
					matrix.makeRotationFromEuler(rotation).setPosition(-index * layout.spacing, 0, 0),
				)
			}
			bricks.instanceMatrix.needsUpdate = true
		}
		updateLayout()
		const cursorPlane = new Plane(new Vector3(0, 0, 1), 0)
		const cursorPoint = new Vector3()
		let cursorX
		/** Eases every brick's hover state toward its target, from the distance to the smoothed cursor. */
		function updateHoverState(delta) {
			const hit = pointer.inside && pointer.raycaster.ray.intersectPlane(cursorPlane, cursorPoint)
			const active = hit ? 1 : 0
			if (hit) {
				const targetX = bricks.worldToLocal(hit).x
				cursorX =
					cursorX === undefined
						? targetX
						: MathUtils.damp(cursorX, targetX, parameters.cursorLerp, delta)
			}
			const scaleResponse = 1 - Math.exp(-SCALE_DAMPING * delta)
			const colorResponse = 1 - Math.exp(-COLOR_DAMPING * delta)
			const state = hoverState.array
			for (let index = 0; index < layout.count; index += 1) {
				const distance = Math.abs((cursorX ?? 0) + index * layout.spacing)
				const hover = active * (1 - MathUtils.smoothstep(distance, 0, parameters.threshold))
				const repulsion =
					active * (1 - MathUtils.smoothstep(distance, 0, uniforms.uRepulsionThreshold.value))
				const offset = index * 3
				state[offset] = MathUtils.lerp(state[offset], hover, scaleResponse)
				state[offset + 1] = MathUtils.lerp(state[offset + 1], hover, colorResponse)
				state[offset + 2] = MathUtils.lerp(state[offset + 2], repulsion, scaleResponse)
			}
			// Hidden bricks restart from rest when the count grows again.
			state.fill(0, layout.count * 3)
			hoverState.needsUpdate = true
			uniforms.uCursorX.value = cursorX ?? 0
		}
		const instances = gui.addFolder({ title: 'Instances' })
		instances.addBinding(layout, 'count', { min: 1, max: MAX_INSTANCES, step: 1 })
		instances.addBinding(layout, 'spacing', { min: 0.1, max: 1.5, step: 0.01 })
		gui.addFolder({ title: 'Initial rotation' }).addBinding(layout, 'initialRotation', {
			x: { min: -180, max: 180, step: 1 },
			y: { min: -180, max: 180, step: 1 },
			z: { min: -180, max: 180, step: 1 },
		})
		gui.addFolder({ title: 'Sequence' }).addBinding(layout, 'rotationIncrementX', {
			label: 'rotation X',
			min: -180,
			max: 180,
			step: 1,
		})
		const composition = gui.addFolder({ title: 'Composition' })
		composition.addBinding(layout, 'offset', {
			x: { min: -10, max: 10, step: 0.01 },
			y: { min: -10, max: 10, step: 0.01 },
		})
		composition
			.addBinding(camera, 'zoom', { min: 0.25, max: 3, step: 0.01 })
			.on('change', () => camera.updateProjectionMatrix())
		gui
			.addFolder({ title: 'Animation' })
			.addBinding(parameters, 'speed', { min: -90, max: 90, step: 1 })
		const interaction = gui.addFolder({ title: 'Interaction' })
		interaction.addBinding(parameters, 'threshold', {
			label: 'Hover threshold',
			min: 0.1,
			max: 5,
			step: 0.05,
		})
		interaction.addBinding(uniforms.uRepulsionThreshold, 'value', {
			label: 'Repulsion threshold',
			min: 0.1,
			max: 8,
			step: 0.05,
		})
		interaction.addBinding(uniforms.uRepulsionStrength, 'value', {
			label: 'Repulsion strength',
			min: 0,
			max: 3,
			step: 0.01,
		})
		interaction.addBinding(uniforms.uRepulsionRotation, 'value', {
			label: 'Rotation strength',
			min: -180,
			max: 180,
			step: 1,
		})
		interaction.addBinding(uniforms.uHoverScale, 'value', {
			label: 'Hover scale',
			min: 0.1,
			max: 3,
			step: 0.01,
		})
		interaction.addBinding(parameters, 'cursorLerp', {
			label: 'Cursor lerp',
			min: 0.1,
			max: 30,
			step: 0.1,
		})
		gui.on('change', updateLayout)
		return {
			update({ delta }) {
				uniforms.uGroupRotationX.value += MathUtils.degToRad(parameters.speed) * delta
				updateHoverState(delta)
			},
		}
	},
})
