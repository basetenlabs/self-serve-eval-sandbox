import { Color, Mesh, PlaneGeometry, ShaderMaterial } from '../../../../lib/three.js'
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform float uIntensity;

  varying vec2 vUv;

  void main() {
    float fade = 1.0 - vUv.x;
    gl_FragColor = vec4(uColor, fade * fade * uIntensity);
    #include <colorspace_fragment>
  }
`
/** Translucent "shadow" on the floor, stretching from the cube toward +X and fading out. */
export function createCubeTrail(scene, gui, color) {
	const parameters = { length: 3.8 }
	const uniforms = {
		uColor: { value: new Color(color) },
		uIntensity: { value: 0.82 },
	}
	const trail = new Mesh(
		new PlaneGeometry(),
		new ShaderMaterial({
			uniforms,
			vertexShader:
				'varying vec2 vUv; void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }',
			fragmentShader,
			transparent: true,
			depthWrite: false,
		}),
	)
	trail.rotation.x = -Math.PI / 2
	trail.position.y = -0.502
	trail.renderOrder = -1
	scene.add(trail)
	/** Length in cube sides; the plane starts at the cube center and grows toward +X. */
	function setLength(length) {
		trail.scale.x = length
		trail.position.x = length / 2
	}
	setLength(parameters.length)
	gui.addBinding(uniforms.uIntensity, 'value', { label: 'Intensity', min: 0, max: 1, step: 0.01 })
	gui
		.addBinding(parameters, 'length', { label: 'Length (cube sides)', min: 0.5, max: 8, step: 0.1 })
		.on('change', ({ value }) => setLength(value))
}
