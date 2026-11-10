import { Color, Mesh, PlaneGeometry, ShaderMaterial } from 'three'
import { getProduct } from '../../palette.js'
import { valueNoise3D } from '../../shaders/noise.js'
import { createMouseTrail } from '../../utils/mouseTrail.js'
import { createHeroProductCube, defineProductHeroScene } from './shared.js'
const FLOOR_SIZE = 9
const BACKGROUND_COLOR = '#F8F2F8'
const CUBE_GRID_CELL_COLOR = '#F4E7F2'
const floorVertexShader = /* glsl */ `
  varying vec2 vWorldXZ;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPosition.xz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`
/** Shared GLSL: stripes are 1 unit deep along Z (one cube size); trail UV maps the whole floor. */
const floorCommon = /* glsl */ `
  uniform float uFloorHalfSize;
  uniform sampler2D uTrailTexture;

  varying vec2 vWorldXZ;

  vec2 floorTrailUv(vec2 worldXZ) {
    return clamp(vec2(worldXZ.x + uFloorHalfSize, uFloorHalfSize - worldXZ.y) / (uFloorHalfSize * 2.0), 0.0, 1.0);
  }
`
/** Gradient stripes that fade out along Z, separated by 1px lines; the trail ripple brightens them. */
const stripesFragmentShader = /* glsl */ `
  uniform vec3 uCenterColor;
  uniform vec3 uEdgeColor;
  uniform vec3 uLineColor;
  uniform float uIntensity;

  ${floorCommon}

  const float LINE_WIDTH_PX = 1.0;
  const float STRIPE_OPACITY_FALLOFF = 0.7;   // opacity multiplier per stripe away from the center

  void main() {
    float stripeIndex = floor(abs(vWorldXZ.y) + 0.5);
    vec3 color = mix(uCenterColor, uEdgeColor, clamp(abs(vWorldXZ.x) / uFloorHalfSize, 0.0, 1.0));
    float ripple = texture2D(uTrailTexture, floorTrailUv(vWorldXZ)).g;
    color *= 1.0 + 1.3 * ripple * ripple;
    float alpha = uIntensity * pow(STRIPE_OPACITY_FALLOFF, stripeIndex);

    float unitsPerPixel = length(vec2(dFdx(vWorldXZ.y), dFdy(vWorldXZ.y)));
    float lineDistancePx = abs(fract(vWorldXZ.y) - 0.5) / max(unitsPerPixel, 0.00001);
    float line = 1.0 - smoothstep(LINE_WIDTH_PX * 0.5 - 0.5, LINE_WIDTH_PX * 0.5 + 0.5, lineDistancePx);
    color = mix(color, uLineColor, line);
    alpha = mix(alpha, 1.0, line);

    gl_FragColor = vec4(color, alpha);
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;
  }
`
/**
 * Dot matrix inside each stripe. A scrolling value noise picks highlighted
 * dots (high threshold) and white ones (low threshold); the trail highlights too.
 */
const dotsFragmentShader = /* glsl */ `
  uniform vec3 uDotColor;
  uniform float uDotOpacity;
  uniform float uRowGap;
  uniform float uColumnGap;
  uniform float uStripePadding;
  uniform float uDotRadius;
  uniform float uTime;
  uniform float uNoiseSpeedX;
  uniform float uNoiseSpeedZ;
  uniform float uNoiseFrequency;
  uniform float uNoiseLowThreshold;
  uniform float uNoiseThreshold;

  ${floorCommon}
  ${valueNoise3D}

  const float ROW_RADIUS = 5.0;   // 11 rows of dots per stripe

  void main() {
    float stripeIndex = floor(vWorldXZ.y + 0.5);
    float localZ = vWorldXZ.y - stripeIndex;
    float rowPitch = min(uRowGap, max((1.0 - 2.0 * (uStripePadding + uDotRadius)) / (ROW_RADIUS * 2.0), 0.001));
    float columnPitch = max(uColumnGap, 0.001);
    float row = clamp(floor(localZ / rowPitch + 0.5), -ROW_RADIUS, ROW_RADIUS);
    float column = floor(vWorldXZ.x / columnPitch + 0.5);
    vec2 dotCenter = vec2(column * columnPitch, stripeIndex + row * rowPitch);

    float dotDistance = length(vWorldXZ - dotCenter);
    float antialias = max(fwidth(dotDistance), 0.00001);
    float coverage = 1.0 - smoothstep(uDotRadius - antialias * 0.5, uDotRadius + antialias * 0.5, dotDistance);
    coverage *= step(abs(localZ), 0.5 - uStripePadding) * step(abs(vWorldXZ.x), uFloorHalfSize - uStripePadding);

    if (coverage <= 0.0) {
      discard;
    }

    vec3 noisePosition = vec3(
      dotCenter.x - uTime * uNoiseSpeedX,
      dotCenter.y - uTime * uNoiseSpeedZ,
      stripeIndex * 0.37
    ) * uNoiseFrequency;
    float noise = valueNoise(noisePosition);
    float trail = texture2D(uTrailTexture, floorTrailUv(dotCenter)).r;
    float selected = max(step(uNoiseThreshold, noise), smoothstep(0.1, 0.6, trail));
    float white = (1.0 - step(uNoiseLowThreshold, noise)) * (1.0 - selected);

    gl_FragColor = vec4(mix(uDotColor, vec3(1.0), white), coverage * mix(uDotOpacity, 1.0, selected));
    #include <colorspace_fragment>
    gl_FragColor.rgb *= gl_FragColor.a;
  }
`
/** Model APIs (pink): the hero cube sits on striped, dotted lanes that react to the pointer. */
export function createModelApisHeroScene({ product = getProduct('model-apis'), videoUrl } = {}) {
	return defineProductHeroScene({
		name: 'Product Hero · Model APIs',
		create(context) {
			const { scene, renderer, pointer, gui } = context
			scene.background = new Color(BACKGROUND_COLOR)
			const floorTrail = createMouseTrail(renderer, {
				resolution: 96,
				radius: 0.013,
				rippleDistance: 0.3,
				rippleDecay: 0.98,
			})
			const sharedUniforms = {
				uFloorHalfSize: { value: FLOOR_SIZE / 2 },
				uTrailTexture: floorTrail.texture,
			}
			const stripesUniforms = {
				...sharedUniforms,
				uCenterColor: { value: new Color('#F6AAF9') },
				uEdgeColor: { value: new Color('#F4E7F2') },
				uLineColor: { value: new Color('#C7D4C4') },
				uIntensity: { value: 1 },
			}
			const dotsUniforms = {
				...sharedUniforms,
				uDotColor: { value: new Color('#AC0EB2') },
				uDotOpacity: { value: 0.12 },
				uRowGap: { value: 0.08 },
				uColumnGap: { value: 0.055 },
				uStripePadding: { value: 0.08 },
				uDotRadius: { value: 0.012 },
				uTime: { value: 0 },
				uNoiseSpeedX: { value: 0.33 },
				uNoiseSpeedZ: { value: 0.19 },
				uNoiseFrequency: { value: 8 },
				uNoiseLowThreshold: { value: 0.5 },
				uNoiseThreshold: { value: 0.87 },
			}
			const createFloorLayer = (fragmentShader, uniforms) => {
				const layer = new Mesh(
					new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
					new ShaderMaterial({
						uniforms,
						vertexShader: floorVertexShader,
						fragmentShader,
						transparent: true,
						premultipliedAlpha: true,
						depthWrite: false,
					}),
				)
				layer.rotation.x = -Math.PI / 2
				layer.position.y = -0.52
				scene.add(layer)
				return layer
			}
			const floor = createFloorLayer(stripesFragmentShader, stripesUniforms)
			const dots = createFloorLayer(dotsFragmentShader, dotsUniforms)
			dots.position.y += 0.001
			dots.renderOrder = 1
			const cube = createHeroProductCube(context, {
				product,
				gridCellColor: CUBE_GRID_CELL_COLOR,
				videoUrl,
			})
			gui.addBinding(stripesUniforms.uIntensity, 'value', {
				label: 'Floor intensity',
				min: 0,
				max: 1,
				step: 0.01,
			})
			const dotsFolder = gui.addFolder({ title: 'Circle grid' })
			dotsFolder.addBinding(dotsUniforms.uRowGap, 'value', {
				label: 'Row gap',
				min: 0.025,
				max: 0.09,
				step: 0.001,
			})
			dotsFolder.addBinding(dotsUniforms.uColumnGap, 'value', {
				label: 'Column gap',
				min: 0.015,
				max: 0.09,
				step: 0.001,
			})
			dotsFolder.addBinding(dotsUniforms.uStripePadding, 'value', {
				label: 'Stripe padding',
				min: 0,
				max: 0.2,
				step: 0.005,
			})
			dotsFolder.addBinding(dotsUniforms.uDotRadius, 'value', {
				label: 'Circle radius',
				min: 0.002,
				max: 0.035,
				step: 0.001,
			})
			const noiseFolder = gui.addFolder({ title: 'Circle noise' })
			noiseFolder.addBinding(dotsUniforms.uNoiseSpeedX, 'value', {
				label: 'X speed',
				min: 0,
				max: 6,
				step: 0.01,
			})
			noiseFolder.addBinding(dotsUniforms.uNoiseSpeedZ, 'value', {
				label: 'Z speed',
				min: 0,
				max: 0.5,
				step: 0.005,
			})
			noiseFolder.addBinding(dotsUniforms.uNoiseFrequency, 'value', {
				label: 'Frequency',
				min: 0.1,
				max: 16,
				step: 0.01,
			})
			noiseFolder.addBinding(dotsUniforms.uNoiseThreshold, 'value', {
				label: 'High threshold',
				min: 0,
				max: 1,
				step: 0.01,
			})
			noiseFolder.addBinding(dotsUniforms.uNoiseLowThreshold, 'value', {
				label: 'Low threshold',
				min: 0,
				max: 1,
				step: 0.01,
			})
			const trailFolder = gui.addFolder({ title: 'Floor trail' })
			trailFolder.addBinding(floorTrail.radius, 'value', {
				label: 'Trail radius',
				min: 0,
				max: 0.1,
				step: 0.001,
			})
			return {
				update(frame) {
					dotsUniforms.uTime.value = frame.elapsed
					// Only the nearest hit counts: the cube occludes the floor behind it.
					const hit = pointer.inside
						? pointer.raycaster.intersectObjects([cube.mesh, floor], false)[0]
						: undefined
					const onCubeGrid = hit?.object === cube.mesh && hit.face && hit.face.normal.z > 0.5
					const cubeUv = onCubeGrid && hit.uv ? hit.uv : null
					const floorUv = hit?.object === floor && hit.uv ? hit.uv : null
					cube.update(frame, cubeUv)
					floorTrail.update(floorUv, frame.delta)
				},
				dispose() {
					cube.dispose()
					floorTrail.dispose()
				},
			}
		},
	})
}
/** Model APIs hero with the default look from `PRODUCTS`. */
export const modelApisHeroScene = createModelApisHeroScene()
