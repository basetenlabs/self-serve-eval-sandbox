import { Color, ShaderMaterial } from '../../lib/three.js'
import { DARK_COLOR, parseFacePattern, PRODUCTS } from '../palette.js'
import { aastep, faceGrid } from '../shaders/common.js'
import { perlinNoise3D } from '../shaders/noise.js'
const vertexShader = /* glsl */ `
  varying vec2 vUv;
  varying vec3 vObjectNormal;
  varying vec2 vParallaxDirection;

  // How far the (orthographic) view ray slides across a face per unit of depth,
  // expressed in that face's tangent space.
  vec2 viewSlide(vec3 tangentX, vec3 tangentY, vec3 faceNormal) {
    return vec2(normalize(normalMatrix * tangentX).z, normalize(normalMatrix * tangentY).z)
      / max(normalize(normalMatrix * faceNormal).z, 0.0001);
  }

  void main() {
    vUv = uv;
    vObjectNormal = normal;
    vParallaxDirection = -viewSlide(vec3(1.0, 0.0, 0.0), vec3(0.0, 1.0, 0.0), vec3(0.0, 0.0, 1.0));
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`
const fragmentShader = /* glsl */ `
  uniform vec3 uColor;
  uniform vec3 uGridCellColor;
  uniform vec3 uDarkColor;
  uniform int uPatternMask;
  uniform float uSeed;
  uniform float uProgress;
  uniform float uHoleProgress;
  uniform float uTrailInfluence;
  uniform float uTime;
  uniform sampler2D uVideoTexture;
  uniform sampler2D uTrailTexture;

  varying vec2 vUv;
  varying vec3 vObjectNormal;
  varying vec2 vParallaxDirection;

  const float DARK_INTENSITY = 0.1;              // brightness of an inactive cube (uProgress = 0)
  const float POSITIVE_X_SHADE = 0.6;            // the +X face is always darker
  const float VIDEO_BLACK_THRESHOLD = 0.1;       // video pixels darker than this become pure black
  const float HOLE_DEPTH = 0.5;                  // pattern holes, in cell sizes
  const float HOLE_NOISE_AMPLITUDE = 0.35;
  const float HOLE_NOISE_FREQUENCY = 0.85;
  const vec2 HOLE_WALL_DARKNESS = vec2(0.45, 0.85);       // left, right wall
  const float WHITE_HOLE_DEPTH = 0.7;                      // non-pattern cells under the trail
  const vec2 WHITE_HOLE_WALL_DARKNESS = vec2(0.25, 0.45);
  const float TRAIL_FLATTENS_HOLES = 0.95;       // how much the trail fills the pattern holes
  // The 8-bit trail buffer never fades below ~0.14 at 60fps (a step under half a level
  // rounds back up): weaker trail is ignored, so faces settle back completely.
  const float TRAIL_MINIMUM = 0.15;

  ${perlinNoise3D}
  ${aastep}
  ${faceGrid}

  // A hole seen through a square cell: the back (floor) slides with the view
  // direction and the walls fill the uncovered part, split along the diagonal.
  vec3 holeColor(vec2 cellUv, float depth, vec3 floorColor, vec2 wallDarkness) {
    depth = clamp(depth, 0.0, 1.0);
    if (depth <= 0.00001) {
      return floorColor;
    }
    vec2 backUv = cellUv + vParallaxDirection * depth;
    vec2 insideBack = min(backUv, 1.0 - backUv);
    float back = aastep(min(insideBack.x, insideBack.y));
    float rightWall = aastep(cellUv.x + cellUv.y - 1.0);
    vec3 wall = mix(
      mix(uColor, uDarkColor, wallDarkness.x),
      mix(uColor, uDarkColor, wallDarkness.y),
      rightWall
    );
    return mix(wall, floorColor, back);
  }

  void main() {
    vec3 color = uColor;

    if (vObjectNormal.x < -0.5) {
      // -X face: the code video, tinted by the cube color.
      vec3 video = texture2D(uVideoTexture, vUv).rgb;
      video *= step(VIDEO_BLACK_THRESHOLD, dot(video, vec3(0.2126, 0.7152, 0.0722)));
      color = video * uColor;
    }
    else if (vObjectNormal.z > 0.5) {
      // +Z face: 5x5 grid. Pattern cells are animated dark holes; the other
      // cells open into white holes where the pointer trail passes.
      float trail = clamp(
        (texture2D(uTrailTexture, vUv).r * uTrailInfluence - TRAIL_MINIMUM) / (1.0 - TRAIL_MINIMUM),
        0.0,
        1.0
      );
      vec2 cell = faceGridCell(vUv);
      vec2 cellUv = faceGridCellUv(vUv, cell);
      float border = faceGridBorder(vUv, 1.0);
      float hole = patternHole(cell, uPatternMask);

      float holeProgress = clamp(uHoleProgress, 0.0, 1.0);
      float depth = HOLE_DEPTH * holeProgress;
      if (hole > 0.5 && holeProgress > 0.00001) {
        vec3 noisePosition = vec3(cell + uSeed * vec2(5.37, 3.71), uTime) * HOLE_NOISE_FREQUENCY;
        depth += perlinNoise(noisePosition) * HOLE_NOISE_AMPLITUDE * holeProgress;
      }

      vec3 darkHole = holeColor(cellUv, depth * (1.0 - trail * TRAIL_FLATTENS_HOLES), uDarkColor, HOLE_WALL_DARKNESS);
      vec3 whiteHole = holeColor(cellUv, WHITE_HOLE_DEPTH * trail, uGridCellColor, WHITE_HOLE_WALL_DARKNESS);
      color = mix(uGridCellColor, uColor, border);
      color = mix(color, whiteHole, (1.0 - hole) * (1.0 - border));
      color = mix(color, darkHole, hole * (1.0 - border));
    }

    color *= mix(DARK_INTENSITY, 1.0, clamp(uProgress, 0.0, 1.0));
    color *= mix(1.0, POSITIVE_X_SHADE, step(0.5, vObjectNormal.x));

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`
/**
 * The product cube look, for a unit `BoxGeometry`:
 * +Z face = 5×5 grid, black pattern cells punched as animated holes,
 * -X face = code video, +X face = shaded body color.
 */
export function createProductCubeMaterial({
	product,
	videoTexture,
	trailTexture,
	gridCellColor = '#FFFFFF',
}) {
	const uniforms = {
		uColor: { value: new Color(product.color) },
		uGridCellColor: { value: new Color(gridCellColor) },
		uDarkColor: { value: new Color(DARK_COLOR) },
		uPatternMask: { value: parseFacePattern(product.pattern) },
		/** Decorrelates the hole animation between products. */
		uSeed: { value: PRODUCTS.findIndex(({ id }) => id === product.id) },
		/** 0 = inactive (dimmed), 1 = active. */
		uProgress: { value: 1 },
		/** Depth of the pattern holes, 0..1. */
		uHoleProgress: { value: 1 },
		/** Multiplies the trail texture (0 ignores the pointer). */
		uTrailInfluence: { value: 1 },
		uTime: { value: 0 },
		uVideoTexture: { value: videoTexture },
		uTrailTexture: trailTexture,
	}
	const material = new ShaderMaterial({ uniforms, vertexShader, fragmentShader })
	return { material, uniforms }
}
/** UV under the pointer on the +Z (grid) face of a product cube, or null. */
export function pointerOnGridFace(pointer, cube) {
	if (!pointer.inside) {
		return null
	}
	const hit = pointer.raycaster.intersectObject(cube, false)[0]
	return hit?.uv && hit.face && hit.face.normal.z > 0.5 ? hit.uv : null
}
