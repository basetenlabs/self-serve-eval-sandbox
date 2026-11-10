import {
	Color,
	LinearFilter,
	Mesh,
	NearestFilter,
	OrthographicCamera,
	PlaneGeometry,
	Scene,
	ShaderMaterial,
	Vector2,
	WebGLRenderTarget,
} from 'three'
const fragmentShader = /* glsl */ `
  uniform sampler2D uPreviousTrail;
  uniform vec2 uPointerUv;
  uniform float uBrushStrength;
  uniform float uDelta;
  uniform float uDecayRate;
  uniform float uRadius;
  uniform vec2 uAspectScale;
  uniform vec2 uRippleOffset;
  uniform float uRippleDecay;

  varying vec2 vUv;

  void main() {
    float delta = min(uDelta, 0.1);
    float brush = uBrushStrength * (1.0 - smoothstep(0.0, uRadius, length((vUv - uPointerUv) * uAspectScale)));

    // R: exponential fade of the painted trail.
    float trail = max(texture(uPreviousTrail, vUv).r * exp(-uDecayRate * delta), brush);

    // G: ripple that spreads to the diagonal neighbours every frame while decaying.
    vec2 o = uRippleOffset;
    float neighbours = max(
      max(texture(uPreviousTrail, vUv + vec2(-o.x, o.y)).g, texture(uPreviousTrail, vUv + o).g),
      max(texture(uPreviousTrail, vUv - o).g, texture(uPreviousTrail, vUv + vec2(o.x, -o.y)).g)
    );
    float ripple = max(neighbours * pow(uRippleDecay, delta * 60.0), brush);

    gl_FragColor = vec4(trail, ripple, 0.0, 1.0);
  }
`
/**
 * Ping-pong render target that "paints" where the pointer is and fades over
 * time. Sample `texture` in a material: R is the trail, G a spreading ripple.
 */
export function createMouseTrail(
	renderer,
	{
		resolution = 25,
		radius = 0.6,
		halfLife = 0.8,
		aspectRatio = 1,
		textureFilter = 'linear',
		rippleDistance = 1,
		rippleDecay = 0.985,
		velocitySensitive = false,
	} = {},
) {
	const filter = textureFilter === 'nearest' ? NearestFilter : LinearFilter
	const createTarget = () =>
		new WebGLRenderTarget(resolution, resolution, {
			depthBuffer: false,
			generateMipmaps: false,
			minFilter: filter,
			magFilter: filter,
		})
	let readTarget = createTarget()
	let writeTarget = createTarget()
	const uniforms = {
		uPreviousTrail: { value: readTarget.texture },
		uPointerUv: { value: new Vector2() },
		uBrushStrength: { value: 0 },
		uDelta: { value: 0 },
		uDecayRate: { value: Math.LN2 / halfLife },
		uRadius: { value: radius },
		uAspectScale: { value: new Vector2(1, 1) },
		uRippleOffset: { value: new Vector2() },
		uRippleDecay: { value: rippleDecay },
	}
	const material = new ShaderMaterial({
		uniforms,
		vertexShader: 'varying vec2 vUv; void main() { vUv = uv; gl_Position = vec4(position, 1.0); }',
		fragmentShader,
		depthTest: false,
		depthWrite: false,
	})
	const quad = new Mesh(new PlaneGeometry(2, 2), material)
	quad.frustumCulled = false
	const scene = new Scene().add(quad)
	const camera = new OrthographicCamera()
	/** Uniform with the latest trail texture: pass it straight to materials. */
	const texture = { value: readTarget.texture }
	const previousPointerUv = new Vector2()
	let hasPreviousPointer = false
	function setAspectRatio(aspect) {
		const safeAspect = Math.max(aspect, 0.0001)
		uniforms.uAspectScale.value.set(Math.min(safeAspect, 1), Math.min(1 / safeAspect, 1))
		uniforms.uRippleOffset.value
			.set(rippleDistance / resolution, rippleDistance / resolution)
			.divide(uniforms.uAspectScale.value)
	}
	function clear() {
		const previousTarget = renderer.getRenderTarget()
		const previousColor = renderer.getClearColor(new Color())
		const previousAlpha = renderer.getClearAlpha()
		renderer.setClearColor(0x000000, 0)
		for (const target of [readTarget, writeTarget]) {
			renderer.setRenderTarget(target)
			renderer.clear(true, false, false)
		}
		renderer.setRenderTarget(previousTarget)
		renderer.setClearColor(previousColor, previousAlpha)
		hasPreviousPointer = false
	}
	/** Call once per frame; pass `null` when the pointer is not over the surface. */
	function update(pointerUv, delta) {
		let strength = 0
		if (pointerUv) {
			strength = 1
			if (velocitySensitive) {
				const speed = hasPreviousPointer
					? previousPointerUv.sub(pointerUv).multiply(uniforms.uAspectScale.value).length() /
						Math.max(delta, 1 / 240)
					: 0
				strength = Math.min(speed * 1.5, 1)
				previousPointerUv.copy(pointerUv)
				hasPreviousPointer = true
			}
			uniforms.uPointerUv.value.copy(pointerUv)
		} else {
			hasPreviousPointer = false
		}
		uniforms.uBrushStrength.value = strength
		uniforms.uDelta.value = delta
		uniforms.uPreviousTrail.value = readTarget.texture
		const previousTarget = renderer.getRenderTarget()
		renderer.setRenderTarget(writeTarget)
		renderer.render(scene, camera)
		renderer.setRenderTarget(previousTarget)
		;[readTarget, writeTarget] = [writeTarget, readTarget]
		texture.value = readTarget.texture
	}
	setAspectRatio(aspectRatio)
	clear()
	return {
		texture,
		/** Brush radius uniform, bindable from the debug panel. */
		radius: uniforms.uRadius,
		update,
		clear,
		setAspectRatio,
		dispose() {
			readTarget.dispose()
			writeTarget.dispose()
			quad.geometry.dispose()
			material.dispose()
		},
	}
}
