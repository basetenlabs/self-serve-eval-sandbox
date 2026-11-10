import { Color, NearestFilter, ShaderMaterial, SRGBColorSpace, TextureLoader, Vector2 } from 'three'
import { defineScene } from '../core/types.js'
import { createStore } from '../core/store.js'
import { BRAND_COLORS } from '../palette.js'
import { createFullscreenMesh } from '../shaders/common.js'
import { createMouseTrail } from '../utils/mouseTrail.js'
const DEFAULT_IMAGE_URL = '/bg-glitch-example.jpg'
/** Seconds; matches the foreground crossfade in ScrollDrivenFeatures.module.scss. */
const TRANSITION_DURATION = 0.6
const vertexShader = /* glsl */ `
  varying vec2 vUv;

  void main() {
    vUv = position.xy * 0.5 + 0.5;
    gl_Position = vec4(position, 1.0);
  }
`
/**
 * The image is sampled on a coarse pixel grid; every "pixel" is displaced
 * along X or Y by an animated noise with random per-pixel frequency and
 * amplitude (both boosted under the pointer trail), tinted (lightened towards
 * the tint, or multiplied by it with `MULTIPLY`), and overlaid with an
 * isometric line grid. On an image or tint change the previous tinted image
 * crossfades into the new one as `uTransition` goes from 0 to 1.
 */
const fragmentShader = /* glsl */ `
  uniform sampler2D uTexture;
  uniform sampler2D uPreviousTexture;
  uniform float uTransition;
  uniform vec2 uResolution;
  uniform vec2 uTextureSize;
  uniform vec2 uPreviousTextureSize;
  uniform vec2 uSubdivisions;
  uniform vec3 uTint;
  uniform vec3 uPreviousTint;
  uniform float uTintIntensity;
  uniform float uTime;
  uniform float uNoiseAmplitude;
  uniform float uNoiseFrequency;
  uniform float uBrightness;
  uniform float uImageZoom;
  uniform sampler2D uMouseTrail;
  uniform float uTrailLightenIntensity;
  uniform float uGridStep;
  uniform float uGridIntensity;

  varying vec2 vUv;

  float random(vec2 coordinate) {
    return fract(sin(dot(coordinate, vec2(12.9898, 78.233))) * 43758.5453);
  }

  vec3 randomGradient(vec3 coordinate) {
    vec3 value = vec3(
      dot(coordinate, vec3(127.1, 311.7, 74.7)),
      dot(coordinate, vec3(269.5, 183.3, 246.1)),
      dot(coordinate, vec3(113.5, 271.9, 124.6))
    );
    return -1.0 + 2.0 * fract(sin(value) * 43758.5453);
  }

  // Gradient noise with a cheap hash (different look from the shared Perlin chunk).
  float gradientNoise(vec3 position) {
    vec3 cell = floor(position);
    vec3 f = fract(position);
    vec3 fade = f * f * (3.0 - 2.0 * f);
    vec2 e = vec2(1.0, 0.0);

    return mix(
      mix(
        mix(dot(randomGradient(cell), f), dot(randomGradient(cell + e.xyy), f - e.xyy), fade.x),
        mix(dot(randomGradient(cell + e.yxy), f - e.yxy), dot(randomGradient(cell + e.xxy), f - e.xxy), fade.x),
        fade.y
      ),
      mix(
        mix(dot(randomGradient(cell + e.yyx), f - e.yyx), dot(randomGradient(cell + e.xyx), f - e.xyx), fade.x),
        mix(dot(randomGradient(cell + e.yxx), f - e.yxx), dot(randomGradient(cell + e.xxx), f - e.xxx), fade.x),
        fade.y
      ),
      fade.z
    );
  }

  float gridLine(vec2 pixelPosition, vec2 normal, float gridStep) {
    float coordinate = dot(pixelPosition, normal);
    float distanceFromLine = abs(mod(coordinate + gridStep * 0.5, gridStep) - gridStep * 0.5);
    float antialias = fwidth(coordinate);
    return 1.0 - smoothstep(0.5 - antialias, 0.5 + antialias, distanceFromLine);
  }

  // "Cover" fit of an image, then zoom. Each image has its own aspect ratio.
  vec2 coverUv(vec2 uv, vec2 textureSize) {
    float canvasAspect = uResolution.x / uResolution.y;
    float textureAspect = textureSize.x / textureSize.y;
    vec2 coverScale = vec2(min(canvasAspect / textureAspect, 1.0), min(textureAspect / canvasAspect, 1.0));
    return (uv - 0.5) * coverScale / uImageZoom + 0.5;
  }

  vec3 tinted(vec3 color, vec3 tint) {
    #ifdef MULTIPLY
      return mix(color, color * tint, uTintIntensity);
    #else
      return mix(color, max(color, tint), uTintIntensity);
    #endif
  }

  void main() {
    vec2 pixelGrid = vec2(uSubdivisions.x, uSubdivisions.y * uResolution.y / uResolution.x);
    vec2 pixelCoordinate = floor(vUv * pixelGrid);
    vec2 pixelUv = (pixelCoordinate + 0.5) / pixelGrid;
    float trail = texture2D(uMouseTrail, pixelUv).g;

    float randomA = random(pixelCoordinate);
    float randomB = random(pixelCoordinate + vec2(37.17, 91.53));
    float frequency = max(randomA + randomB, 0.01) * uNoiseFrequency * (1.0 + trail * 0.25);
    float amplitude = (randomA + 1.0) * (randomB + 1.0) * uNoiseAmplitude * (1.0 + trail * 3.0);
    float noise = gradientNoise(vec3(pixelCoordinate * frequency, uTime * uNoiseFrequency));
    vec2 displacement = (randomA > 0.5 ? vec2(0.0, 1.0) : vec2(1.0, 0.0)) * noise * amplitude;

    vec4 previousImage = texture2D(uPreviousTexture, coverUv(pixelUv, uPreviousTextureSize) + displacement);
    vec4 image = texture2D(uTexture, coverUv(pixelUv, uTextureSize) + displacement);
    float transition = smoothstep(0.0, 1.0, uTransition);
    vec3 color = mix(tinted(previousImage.rgb, uPreviousTint), tinted(image.rgb, uTint), transition);
    float alpha = mix(previousImage.a, image.a, transition);
    color = mix(color, vec3(1.0), trail * trail * uTrailLightenIntensity);

    // Isometric grid (lines at 30 and 150 degrees), in screen pixels.
    vec2 gridPosition = (vUv - 0.5) * uResolution;
    float gridStep = max(uGridStep, 1.0);
    float grid = max(
      gridLine(gridPosition, vec2(-0.5, 0.8660254), gridStep),
      gridLine(gridPosition, vec2(0.5, 0.8660254), gridStep)
    );
    color = mix(color, vec3(0.0), grid * uGridIntensity) * uBrightness;

    gl_FragColor = vec4(color, alpha);
    #ifdef MULTIPLY
      // Encoded to sRGB, so the colours match the static texture multiplied in CSS
      #include <colorspace_fragment>
    #endif
  }
`
/**
 * Pixelated, noise-displaced image. Update `store.imageUrl` and `store.tint` without
 * recreating the scene; the image on screen crossfades into the new one once it has loaded.
 */
export function createGlitchEffectScene({
	imageUrl = DEFAULT_IMAGE_URL,
	tint = BRAND_COLORS.green,
	blend = 'lighten',
	subdivisionScale = 1,
	trailRadius = 0.24,
	trailResolutionScale = 0.125,
	trailLightenIntensity = 0.15,
	pointerTrail = true,
	onUiVisibilityChange,
} = {}) {
	const multiply = blend === 'multiply'
	const store = createStore({ imageUrl, tint, readyImageUrl: null })
	const definition = defineScene({
		name: 'Glitch Effect',
		camera: { type: 'orthographic', frustumHeight: 5 },
		create({ scene, renderer, size, pointer, gui }) {
			const textureSize = new Vector2(1, 1)
			const previousTextureSize = new Vector2(1, 1)
			const loader = new TextureLoader()
			const textures = new Map()
			const objectUrls = new Set()
			let disposed = false
			let selectedUrl
			let selectedTint
			const trail = createMouseTrail(renderer, {
				resolution: Math.round(Math.max(size.width, size.height) * trailResolutionScale),
				radius: trailRadius,
				aspectRatio: size.aspect,
				textureFilter: 'nearest',
				velocitySensitive: true,
			})
			const parameters = {
				tint: store.get().tint,
				showUi: true,
				transitionDuration: TRANSITION_DURATION,
			}
			const uniforms = {
				uTexture: { value: null },
				uPreviousTexture: { value: null },
				uTransition: { value: 1 },
				uResolution: { value: new Vector2(size.width, size.height) },
				uTextureSize: { value: textureSize },
				uPreviousTextureSize: { value: previousTextureSize },
				uSubdivisions: { value: new Vector2(30, 60).multiplyScalar(subdivisionScale) },
				uTint: { value: new Color(parameters.tint) },
				uPreviousTint: { value: new Color(parameters.tint) },
				// A full multiply at plain brightness matches the static texture over the tint
				uTintIntensity: { value: multiply ? 1 : 0.85 },
				uTime: { value: 0 },
				uNoiseAmplitude: { value: 0.035 },
				uNoiseFrequency: { value: 0.1 },
				uBrightness: { value: multiply ? 1 : 1.3 },
				uImageZoom: { value: 1.5 },
				uMouseTrail: trail.texture,
				uTrailLightenIntensity: { value: trailLightenIntensity },
				uGridStep: { value: 65 },
				uGridIntensity: { value: 0.07 },
			}
			const mesh = createFullscreenMesh(
				new ShaderMaterial({
					uniforms,
					vertexShader,
					fragmentShader,
					defines: multiply ? { MULTIPLY: '' } : {},
					depthTest: false,
					depthWrite: false,
				}),
			)
			mesh.visible = false
			scene.add(mesh)
			/** Shows `texture` with the selected tint; the pair crossfades as one. */
			function applyTexture(url, texture) {
				if (disposed || selectedUrl !== url) return
				const image = texture.image
				const current = uniforms.uTexture.value
				const tint = new Color(store.get().tint)
				const isCurrent = texture === current && tint.equals(uniforms.uTint.value)
				const isPrevious =
					texture === uniforms.uPreviousTexture.value && tint.equals(uniforms.uPreviousTint.value)
				if (!current) {
					// Nothing on screen yet: the first image appears without a transition.
					uniforms.uTransition.value = 1
				}
				// Fade from the image on screen. When a transition is still running, the image that
				// dominates stays and the other one is replaced, so quick step changes never jump.
				else if (!isCurrent && (isPrevious || uniforms.uTransition.value >= 0.5)) {
					uniforms.uPreviousTexture.value = current
					previousTextureSize.copy(textureSize)
					uniforms.uPreviousTint.value.copy(uniforms.uTint.value)
					uniforms.uTransition.value = 1 - uniforms.uTransition.value
				}
				textureSize.set(image.naturalWidth, image.naturalHeight)
				uniforms.uTexture.value = texture
				uniforms.uTint.value.copy(tint)
				mesh.visible = true
				store.set({ readyImageUrl: url })
			}
			/** No image, or it failed: the static image underneath the canvas takes over. */
			function hide() {
				mesh.visible = false
				uniforms.uTexture.value = null
				uniforms.uPreviousTexture.value = null
				store.set({ readyImageUrl: null })
			}
			function releaseObjectUrl(url) {
				if (objectUrls.delete(url)) URL.revokeObjectURL(url)
			}
			function sync() {
				const { imageUrl, tint } = store.get()
				if (selectedUrl === imageUrl && selectedTint === tint) return
				// A tint change alone fades over the image on screen, and never retries a failed one.
				const tintOnly = selectedUrl === imageUrl
				// The image on screen stays until the new one has loaded (see applyTexture).
				selectedUrl = imageUrl
				selectedTint = tint
				parameters.tint = tint
				if (!imageUrl) {
					hide()
					return
				}
				const cached = textures.get(imageUrl)
				if (cached) {
					if (cached.loaded) applyTexture(imageUrl, cached.texture)
					return
				}
				if (tintOnly) return
				const texture = loader.load(
					imageUrl,
					(loaded) => {
						releaseObjectUrl(imageUrl)
						if (disposed) {
							loaded.dispose()
							return
						}
						const entry = textures.get(imageUrl)
						if (entry) entry.loaded = true
						applyTexture(imageUrl, loaded)
					},
					undefined,
					() => {
						releaseObjectUrl(imageUrl)
						textures.get(imageUrl)?.texture.dispose()
						textures.delete(imageUrl)
						if (!disposed && selectedUrl === imageUrl) hide()
					},
				)
				texture.colorSpace = SRGBColorSpace
				texture.minFilter = NearestFilter
				texture.magFilter = NearestFilter
				texture.generateMipmaps = false
				textures.set(imageUrl, { texture, loaded: false })
			}
			const unsubscribe = store.subscribe(sync)
			sync()
			// Custom image: a hidden file input driven by a debug button.
			const fileInput = Object.assign(document.createElement('input'), {
				type: 'file',
				accept: 'image/*',
				hidden: true,
			})
			fileInput.addEventListener('change', () => {
				const file = fileInput.files?.[0]
				fileInput.value = ''
				if (!file) {
					return
				}
				const url = URL.createObjectURL(file)
				objectUrls.add(url)
				store.set({ imageUrl: url })
			})
			gui.element.append(fileInput)
			const subdivisions = uniforms.uSubdivisions.value
			gui.addBinding(subdivisions, 'x', { label: 'Horizontal', min: 1, max: 256, step: 1 })
			gui.addBinding(subdivisions, 'y', { label: 'Vertical', min: 1, max: 256, step: 1 })
			gui.addBinding(uniforms.uImageZoom, 'value', {
				label: 'Image zoom',
				min: 1,
				max: 2,
				step: 0.01,
			})
			gui.addBinding(parameters, 'transitionDuration', {
				label: 'Transition (s)',
				min: 0,
				max: 3,
				step: 0.05,
			})
			gui
				.addBinding(parameters, 'tint', {
					label: 'Color',
					options: Object.fromEntries(
						Object.entries(BRAND_COLORS).map(([name, color]) => [
							name[0].toUpperCase() + name.slice(1),
							color,
						]),
					),
				})
				.on('change', ({ value }) => store.set({ tint: value }))
			gui.addBinding(uniforms.uTintIntensity, 'value', {
				label: 'Color intensity',
				min: 0,
				max: 1,
				step: 0.01,
			})
			gui.addBinding(uniforms.uBrightness, 'value', {
				label: 'Brightness',
				min: 0,
				max: 2,
				step: 0.01,
			})
			gui.addBinding(uniforms.uNoiseAmplitude, 'value', {
				label: 'Noise amplitude',
				min: 0,
				max: 0.25,
				step: 0.001,
			})
			gui.addBinding(uniforms.uNoiseFrequency, 'value', {
				label: 'Noise frequency',
				min: 0,
				max: 2,
				step: 0.01,
			})
			gui.addBinding(trail.radius, 'value', { label: 'Trail radius', min: 0, max: 0.5, step: 0.01 })
			gui.addBinding(uniforms.uTrailLightenIntensity, 'value', {
				label: 'Trail lighten',
				min: 0,
				max: 1,
				step: 0.01,
			})
			gui.addBinding(uniforms.uGridStep, 'value', { label: 'Grid step', min: 4, max: 160, step: 1 })
			gui.addBinding(uniforms.uGridIntensity, 'value', {
				label: 'Grid intensity',
				min: 0,
				max: 1,
				step: 0.01,
			})
			gui
				.addBinding(parameters, 'showUi', { label: 'Show UI' })
				.on('change', ({ value }) => onUiVisibilityChange?.(value))
			gui.addButton({ title: 'Change Bg Image' }).on('click', () => fileInput.click())
			onUiVisibilityChange?.(parameters.showUi)
			return {
				update({ delta, elapsed }) {
					uniforms.uTime.value = elapsed
					uniforms.uTransition.value = Math.min(
						1,
						uniforms.uTransition.value + delta / Math.max(parameters.transitionDuration, 0.001),
					)
					// Without the trail its cleared texture stays black, so the shader sees no trail
					if (pointerTrail) trail.update(pointer.inside ? pointer.uv : null, delta)
				},
				resize({ width, height, aspect }) {
					uniforms.uResolution.value.set(width, height)
					trail.setAspectRatio(aspect)
				},
				dispose() {
					disposed = true
					unsubscribe()
					// The cache owns these textures, including the ones referenced by the material.
					hide()
					textures.forEach(({ texture }) => texture.dispose())
					textures.clear()
					objectUrls.forEach((url) => URL.revokeObjectURL(url))
					objectUrls.clear()
					trail.dispose()
				},
			}
		},
	})
	return Object.assign(definition, { store })
}
