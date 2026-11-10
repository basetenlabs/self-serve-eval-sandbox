import {
	DynamicDrawUsage,
	Float32BufferAttribute,
	InstancedBufferAttribute,
	InstancedBufferGeometry,
	Mesh,
	ShaderMaterial,
} from 'three'
/** Dots are pixel-sized quads facing the camera, so they stay round on the floor. */
const vertexShader = /* glsl */ `
  attribute vec3 aCenter;
  // x: diameter (px), y: opacity.
  attribute vec2 aLook;

  uniform vec2 uViewportPx;

  varying vec2 vCorner;
  varying float vOpacity;

  void main() {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(aCenter, 1.0);
    clip.xy += position.xy * aLook.x / uViewportPx * clip.w;
    gl_Position = clip;
    vCorner = position.xy;
    vOpacity = aLook.y;
  }
`
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uEdgeSoftness;

  varying vec2 vCorner;
  varying float vOpacity;

  void main() {
    float coverage = smoothstep(0.0, uEdgeSoftness, 1.0 - length(vCorner));
    if (coverage <= 0.0) {
      discard;
    }
    gl_FragColor = vec4(uColor, coverage * vOpacity);
    #include <colorspace_fragment>
  }
`
/** Up to `capacity` dots, set again every frame with `add`, then drawn by `commit`. */
export function createDots(capacity, uniforms) {
	const geometry = new InstancedBufferGeometry()
	geometry.setAttribute(
		'position',
		new Float32BufferAttribute([-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0], 3),
	)
	geometry.setIndex([0, 1, 2, 2, 1, 3])
	const centers = new InstancedBufferAttribute(new Float32Array(capacity * 3), 3)
	const looks = new InstancedBufferAttribute(new Float32Array(capacity * 2), 2)
	centers.setUsage(DynamicDrawUsage)
	looks.setUsage(DynamicDrawUsage)
	geometry.setAttribute('aCenter', centers)
	geometry.setAttribute('aLook', looks)
	geometry.instanceCount = 0
	const mesh = new Mesh(
		geometry,
		new ShaderMaterial({
			uniforms,
			vertexShader,
			fragmentShader,
			transparent: true,
			depthWrite: false,
		}),
	)
	// The quad has no real bounds: the dots are wherever their attributes say.
	mesh.frustumCulled = false
	let count = 0
	return {
		mesh,
		add(x, y, z, sizePx, opacity) {
			if (count >= capacity) return
			centers.setXYZ(count, x, y, z)
			looks.setXY(count, sizePx, opacity)
			count += 1
		},
		commit() {
			geometry.instanceCount = count
			centers.needsUpdate = true
			looks.needsUpdate = true
			count = 0
		},
	}
}
