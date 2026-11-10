import {
	BufferGeometry,
	Color,
	DoubleSide,
	Float32BufferAttribute,
	Mesh,
	ShaderMaterial,
	Vector2,
} from 'three'
import { valueNoise3D } from '../../../shaders/noise.js'
/** 6×6 bundle of lines: rows map to height, columns to depth. */
const LANE_SIDE = 6
const LINE_COUNT = LANE_SIDE * LANE_SIDE
const LINE_SEGMENTS = 216
const PARTICLE_COUNT = 260
/** World X range of the flow; the cube spans -0.5..0.5. */
const START_X = -7.5
const END_X = 3.2
const glslFloat = (value) => value.toFixed(2)
/**
 * `trainingPath(x, lineIndex)` returns the world position of a line at `x`:
 * lines start high and fanned out (a loss curve decaying toward the cube),
 * converge into a square on the -X face, cross the cube and exit slightly shifted.
 */
const pathShader = /* glsl */ `
  uniform float uTime;
  uniform float uNoiseAmplitude;
  uniform float uNoiseFrequency;
  uniform float uFanSpread;
  uniform float uLossCurvature;
  uniform float uConvergenceArea;
  uniform float uCubeEntryHalfSize;
  uniform float uExitShift;

  ${valueNoise3D}

  // -1..1 lane coordinates: x = height row, y = depth column.
  vec2 laneCoordinates(float lineIndex) {
    float row = floor(lineIndex / ${glslFloat(LANE_SIDE)});
    float column = mod(lineIndex, ${glslFloat(LANE_SIDE)});
    return vec2(row, column) / ${glslFloat(LANE_SIDE - 1)} * 2.0 - 1.0;
  }

  vec3 trainingPath(float x, float lineIndex) {
    vec2 lane = laneCoordinates(lineIndex);
    float shapeStartX = -0.5 - uConvergenceArea;
    float approach = clamp((x - shapeStartX) / uConvergenceArea, 0.0, 1.0);
    float leftDistance = max(shapeStartX - x, 0.0);
    float decay = exp(-uLossCurvature);
    float loss = (exp(-uLossCurvature * approach) - decay) / (1.0 - decay);
    // Continue the slope past the convergence start, easing its growth farther left.
    loss += (uLossCurvature / (uConvergenceArea * (1.0 - decay))) * log(1.0 + 0.65 * leftDistance) / 0.65;

    float startY = 0.7 + (lane.x + 1.0) * 0.35 + lane.y * 0.035;
    float entryY = lane.x * uCubeEntryHalfSize;
    float exitY = entryY + (hash(vec3(lineIndex + 1.0, 11.0, 0.0)) * 2.0 - 1.0) * uExitShift;
    float startZ = -uFanSpread * (lane.y + lane.x * 0.12 + sin(lineIndex * 2.3) * 0.08);
    float entryZ = -lane.y * uCubeEntryHalfSize;
    float exitZ = entryZ + (hash(vec3(lineIndex + 1.0, 23.0, 0.0)) * 2.0 - 1.0) * uExitShift;
    float inside = smoothstep(-0.5, 0.5, x);
    float fanWeight = pow(1.0 - approach, 1.1) + (1.1 / uConvergenceArea) * log(1.0 + 0.5 * leftDistance) / 0.5;

    float y = mix(mix(entryY, startY, loss), exitY, inside);
    float z = mix(mix(entryZ, startZ, fanWeight), exitZ, inside);

    // Wobble: strong on the loss curve, almost none once the lines converge.
    float noiseEnvelope = x < -0.5 ? mix(0.07, 1.0, min(loss, 1.0)) : mix(0.07, 0.12, inside);
    vec3 noisePosition = vec3(x, lane.x * 0.7 + lane.y * 0.37, uTime * 0.38) * uNoiseFrequency;
    y += (valueNoise(noisePosition) * 2.0 - 1.0) * uNoiseAmplitude * noiseEnvelope;
    z += (valueNoise(noisePosition + vec3(17.3, 8.1, 11.7)) * 2.0 - 1.0) * uNoiseAmplitude * noiseEnvelope * 0.65;

    return vec3(x, y, z);
  }
`
/** Lines are camera-facing ribbons with a constant width in pixels. */
const linesVertexShader = /* glsl */ `
  attribute float aPathX;
  attribute float aSide;
  attribute float aLineIndex;

  uniform vec2 uViewportPx;
  uniform float uLineWidthPx;
  uniform float uOpacityNoiseFrequencyX;
  uniform float uOpacityNoiseFrequencyY;
  uniform float uOpacityNoiseSpeed;
  uniform float uOpacityNoiseThreshold;

  varying float vOpacity;

  ${pathShader}

  vec2 toScreen(vec3 worldPosition) {
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(worldPosition, 1.0);
    return clip.xy / clip.w * uViewportPx;
  }

  void main() {
    vec3 pathPosition = trainingPath(aPathX, aLineIndex);
    vec2 screenTangent = toScreen(trainingPath(min(aPathX + 0.01, ${glslFloat(END_X)}), aLineIndex))
      - toScreen(trainingPath(max(aPathX - 0.01, ${glslFloat(START_X)}), aLineIndex));
    screenTangent = normalize(screenTangent + vec2(0.00001));
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(pathPosition, 1.0);
    clip.xy += vec2(-screenTangent.y, screenTangent.x) * aSide * uLineWidthPx / uViewportPx * clip.w;
    gl_Position = clip;

    // Back lanes are fainter; a scrolling noise dims stretches of every line.
    float depthLane = (laneCoordinates(aLineIndex).y + 1.0) * 0.5;
    vec2 opacityNoisePosition = vec2(
      (pathPosition.x - uTime * uOpacityNoiseSpeed) * uOpacityNoiseFrequencyX,
      pathPosition.y * uOpacityNoiseFrequencyY
    );
    float opacityWeight = smoothstep(
      uOpacityNoiseThreshold - 0.12,
      uOpacityNoiseThreshold + 0.12,
      valueNoise(vec3(opacityNoisePosition, 0.0))
    );
    float startFade = smoothstep(${glslFloat(START_X)}, ${glslFloat(START_X + 1.5)}, aPathX);
    vOpacity = mix(0.42, 0.18, depthLane) * mix(0.08, 1.0, opacityWeight) * startFade;
  }
`
const linesFragmentShader = /* glsl */ `
  uniform vec3 uFlowColor;

  varying float vOpacity;

  void main() {
    gl_FragColor = vec4(uFlowColor, vOpacity);
    #include <colorspace_fragment>
  }
`
/** Particles are pixel-sized quads that travel along the lines, pulsing; one in four floats off its line. */
const particlesVertexShader = /* glsl */ `
  attribute float aPhase;
  attribute float aPulsePhase;
  attribute float aLineIndex;
  attribute vec2 aFreeOffset;
  attribute float aSizeVariationPx;
  attribute float aSpeedScale;

  uniform vec2 uViewportPx;
  uniform float uParticleSpeed;
  uniform float uParticleBaseSizePx;

  varying vec2 vCorner;
  varying float vOpacity;
  varying float vPulse;

  ${pathShader}

  void main() {
    float progress = fract(aPhase + uTime * uParticleSpeed * aSpeedScale / ${glslFloat(END_X - START_X)});
    float x = mix(${glslFloat(START_X)}, ${glslFloat(END_X)}, progress);
    vec3 pathPosition = trainingPath(x, aLineIndex);
    float approach = clamp((x + 0.5 + uConvergenceArea) / uConvergenceArea, 0.0, 1.0);
    pathPosition.yz += aFreeOffset * (x < -0.5 ? mix(0.16, 1.0, 1.0 - approach) : 0.16);

    vPulse = 0.5 + 0.5 * sin(uTime * 6.0 + aPulsePhase * 6.2831853);
    vec4 clip = projectionMatrix * modelViewMatrix * vec4(pathPosition, 1.0);
    clip.xy += position.xy * (uParticleBaseSizePx + aSizeVariationPx) * (0.5 + vPulse) / uViewportPx * clip.w;
    gl_Position = clip;
    vCorner = position.xy;
    vOpacity = mix(0.95, 0.65, (laneCoordinates(aLineIndex).y + 1.0) * 0.5);
  }
`
const particlesFragmentShader = /* glsl */ `
  uniform vec3 uFlowColor;
  uniform float uParticleEdgeSoftness;

  varying vec2 vCorner;
  varying float vOpacity;
  varying float vPulse;

  void main() {
    float coverage = pow(clamp((1.0 - length(vCorner)) / uParticleEdgeSoftness, 0.0, 1.0), 2.0);
    if (coverage <= 0.0) {
      discard;
    }
    vec3 color = mix(uFlowColor * 1.3, uFlowColor * 3.0, vPulse * -0.2);
    gl_FragColor = vec4(color, coverage * vOpacity);
    #include <colorspace_fragment>
  }
`
function createGeometry(attributes, indices) {
	const geometry = new BufferGeometry()
	geometry.setIndex(indices)
	for (const [name, { size, values }] of Object.entries(attributes)) {
		geometry.setAttribute(name, new Float32BufferAttribute(values, size))
	}
	return geometry
}
/** Two vertices (left/right side) per path sample; positions are computed in the shader. */
function createLinesGeometry() {
	const position = []
	const pathX = []
	const side = []
	const lineIndex = []
	const indices = []
	for (let line = 0; line < LINE_COUNT; line += 1) {
		const firstVertex = position.length / 3
		for (let segment = 0; segment <= LINE_SEGMENTS; segment += 1) {
			const x = START_X + ((END_X - START_X) * segment) / LINE_SEGMENTS
			position.push(0, 0, 0, 0, 0, 0)
			pathX.push(x, x)
			side.push(-1, 1)
			lineIndex.push(line, line)
			if (segment < LINE_SEGMENTS) {
				const vertex = firstVertex + segment * 2
				indices.push(vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3)
			}
		}
	}
	return createGeometry(
		{
			position: { size: 3, values: position },
			aPathX: { size: 1, values: pathX },
			aSide: { size: 1, values: side },
			aLineIndex: { size: 1, values: lineIndex },
		},
		indices,
	)
}
/** Deterministic 0..1 pseudo-random, so the particle layout is stable across reloads. */
function random(seed) {
	const value = Math.sin(seed * 127.1) * 43758.5453
	return value - Math.floor(value)
}
function createParticlesGeometry() {
	const corners = [
		[-1, -1],
		[1, -1],
		[-1, 1],
		[1, 1],
	]
	const attributes = {
		position: { size: 3, values: [] },
		aPhase: { size: 1, values: [] },
		aPulsePhase: { size: 1, values: [] },
		aLineIndex: { size: 1, values: [] },
		aFreeOffset: { size: 2, values: [] },
		aSizeVariationPx: { size: 1, values: [] },
		aSpeedScale: { size: 1, values: [] },
	}
	const indices = []
	for (let particle = 0; particle < PARTICLE_COUNT; particle += 1) {
		const angle = random(particle + 10) * Math.PI * 2
		const freeRadius = particle % 4 === 0 ? 0.1 + random(particle + 20) * 0.18 : 0
		const phase = (particle + random(particle + 30) * 0.6) / PARTICLE_COUNT
		const pulsePhase = random(particle + 60)
		const sizeVariation = random(particle + 40) * 2.4
		const speed = 0.85 + random(particle + 50) * 0.3
		for (const [cornerX, cornerY] of corners) {
			attributes.position.values.push(cornerX, cornerY, 0)
			attributes.aPhase.values.push(phase)
			attributes.aPulsePhase.values.push(pulsePhase)
			attributes.aLineIndex.values.push(particle % LINE_COUNT)
			attributes.aFreeOffset.values.push(Math.cos(angle) * freeRadius, Math.sin(angle) * freeRadius)
			attributes.aSizeVariationPx.values.push(sizeVariation)
			attributes.aSpeedScale.values.push(speed)
		}
		const vertex = particle * 4
		indices.push(vertex, vertex + 1, vertex + 2, vertex + 2, vertex + 1, vertex + 3)
	}
	return createGeometry(attributes, indices)
}
/** Loss-curve lines and particles converging into the training cube. */
export function createTrainingFlow(scene, gui, size, color) {
	const uniforms = {
		uTime: { value: 0 },
		uViewportPx: { value: new Vector2(size.width, size.height) },
		uFlowColor: { value: new Color(color) },
		uLineWidthPx: { value: 1.25 },
		uNoiseAmplitude: { value: 0.15 },
		uNoiseFrequency: { value: 3 },
		uFanSpread: { value: 2.1 },
		uLossCurvature: { value: 2 },
		uConvergenceArea: { value: 2.6 },
		uCubeEntryHalfSize: { value: 0.3 },
		uExitShift: { value: 0.03 },
		uOpacityNoiseFrequencyX: { value: 1.6 },
		uOpacityNoiseFrequencyY: { value: 8 },
		uOpacityNoiseSpeed: { value: 1.4 },
		uOpacityNoiseThreshold: { value: 0.25 },
		uParticleSpeed: { value: 0.7 },
		uParticleBaseSizePx: { value: 5.7 },
		uParticleEdgeSoftness: { value: 0.35 },
	}
	const createMaterial = (vertexShader, fragmentShader) =>
		new ShaderMaterial({
			uniforms,
			vertexShader,
			fragmentShader,
			transparent: true,
			depthWrite: false,
			side: DoubleSide,
		})
	const lines = new Mesh(
		createLinesGeometry(),
		createMaterial(linesVertexShader, linesFragmentShader),
	)
	const particles = new Mesh(
		createParticlesGeometry(),
		createMaterial(particlesVertexShader, particlesFragmentShader),
	)
	lines.frustumCulled = false
	particles.frustumCulled = false
	lines.renderOrder = 1
	particles.renderOrder = 2
	scene.add(lines, particles)
	const curves = gui.addFolder({ title: 'Training curves' })
	curves.addBinding(uniforms.uNoiseAmplitude, 'value', {
		label: 'Noise amplitude',
		min: 0,
		max: 0.2,
		step: 0.005,
	})
	curves.addBinding(uniforms.uNoiseFrequency, 'value', {
		label: 'Noise frequency',
		min: 0.2,
		max: 10,
		step: 0.05,
	})
	curves.addBinding(uniforms.uFanSpread, 'value', {
		label: 'Fan spread',
		min: 0,
		max: 3.2,
		step: 0.01,
	})
	curves.addBinding(uniforms.uLossCurvature, 'value', {
		label: 'Loss curvature',
		min: 0.2,
		max: 8,
		step: 0.1,
	})
	curves.addBinding(uniforms.uConvergenceArea, 'value', {
		label: 'Convergence area',
		min: 1,
		max: 6,
		step: 0.1,
	})
	curves.addBinding(uniforms.uCubeEntryHalfSize, 'value', {
		label: 'Cube face area',
		min: 0.05,
		max: 0.45,
		step: 0.01,
	})
	curves.addBinding(uniforms.uExitShift, 'value', {
		label: 'Exit shift',
		min: 0,
		max: 0.12,
		step: 0.005,
	})
	const opacity = gui.addFolder({ title: 'Line opacity' })
	opacity.addBinding(uniforms.uOpacityNoiseFrequencyX, 'value', {
		label: 'Opacity freq X',
		min: 0.1,
		max: 8,
		step: 0.1,
	})
	opacity.addBinding(uniforms.uOpacityNoiseFrequencyY, 'value', {
		label: 'Opacity freq Y',
		min: 0.1,
		max: 8,
		step: 0.1,
	})
	opacity.addBinding(uniforms.uOpacityNoiseSpeed, 'value', {
		label: 'Opacity speed',
		min: -3,
		max: 3,
		step: 0.05,
	})
	opacity.addBinding(uniforms.uOpacityNoiseThreshold, 'value', {
		label: 'Opacity threshold',
		min: 0,
		max: 1,
		step: 0.01,
	})
	const particlesFolder = gui.addFolder({ title: 'Particles' })
	particlesFolder.addBinding(uniforms.uParticleSpeed, 'value', {
		label: 'Particle speed',
		min: 0,
		max: 3,
		step: 0.05,
	})
	particlesFolder.addBinding(uniforms.uParticleBaseSizePx, 'value', {
		label: 'Particle size',
		min: 1,
		max: 12,
		step: 0.25,
	})
	particlesFolder.addBinding(uniforms.uParticleEdgeSoftness, 'value', {
		label: 'Edge softness',
		min: 0.01,
		max: 1,
		step: 0.01,
	})
	return {
		update(elapsed) {
			uniforms.uTime.value = elapsed
		},
		resize({ width, height }) {
			uniforms.uViewportPx.value.set(width, height)
		},
	}
}
