import { floorRayHit } from '../../shaders/common.js'
/**
 * Infinite floor drawn on a fullscreen triangle (vertex: `floorRayVertexShader`).
 *
 * Every grid cell gets a color from a hash of (cell, seed): cells near the
 * volumes favour the active slide color, farther cells mix in the others or
 * stay neutral. Changing slide re-seeds the hash and cross-fades cell by cell
 * with a random delay ("shimmer"). Under the pointer trail a whole cell shifts
 * toward its saturated color.
 */
export const floorFragmentShader = /* glsl */ `
  uniform vec3 uFloorColor;
  uniform vec3 uGridColor;
  uniform vec3 uTrailNeutralColor;
  uniform vec3 uPalette[SLIDE_COUNT];
  // Core of each formation: cells around the volumes where the active color
  // dominates (min x, min z, max x, max z).
  uniform vec4 uPreviousCore;
  uniform vec4 uNextCore;
  uniform vec2 uCellSize;
  uniform float uPreviousIndex;
  uniform float uNextIndex;
  uniform float uPreviousSeed;
  uniform float uNextSeed;
  uniform float uTransition;
  uniform float uTrailStrength;
  uniform sampler2D uTrailTexture;
  uniform vec2 uTrailOrigin;
  uniform vec2 uTrailAxisU;
  uniform vec2 uTrailAxisV;

  ${floorRayHit}

  const float CORE_FEATHER = 2.0;              // cells
  const float OUTER_COLOR_DENSITY = 0.45;      // share of colored cells far from the core
  const float LIGHT_VARIANT = 0.6;             // colored cells below this hash are lightened...
  const float DARK_VARIANT = 0.95;             // ...and above this one darkened
  const float LIGHTEN = 0.5;
  const float DARKEN = 0.45;
  const float RESTING_LIGHTEN = 0.3;           // cells at rest are lighter than under the trail
  const float SHIMMER_DELAY = 0.65;            // max per-cell delay of a slide change (0..1 of it)
  const float SHIMMER_DURATION = 0.35;
  const float LINE_WIDTH = 0.75;               // grid lines, in pixels

  float cellHash(vec2 cell, float seed, float salt) {
    vec2 seeded = cell + vec2(seed * 19.19 + salt * 7.73, seed * 3.17 - salt * 11.13);
    return fract(sin(dot(seeded, vec2(127.1, 311.7))) * 43758.5453123);
  }

  float coreInfluence(vec2 cell, vec4 core) {
    vec2 distanceFromCore = max(core.xy - cell, cell - core.zw);
    float outside = max(max(distanceFromCore.x, distanceFromCore.y), 0.0);
    return 1.0 - smoothstep(0.5, CORE_FEATHER + 0.5, outside);
  }

  struct CellStyle {
    vec3 trailColor;     // shown under the pointer trail
    vec3 restingColor;   // shown otherwise
  };

  CellStyle cellStyle(vec2 cell, float activeIndex, float seed, vec4 core) {
    float influence = coreInfluence(cell, core);

    if (cellHash(cell, seed, 0.0) >= mix(OUTER_COLOR_DENSITY, 1.0, influence)) {
      return CellStyle(uTrailNeutralColor, uFloorColor);
    }

    float colorIndex = activeIndex;
    if (cellHash(cell, seed, 1.0) >= influence) {
      // Any palette color except the active one.
      float other = floor(cellHash(cell, seed, 2.0) * float(SLIDE_COUNT - 1));
      colorIndex = other + step(activeIndex, other);
    }

    vec3 color = uPalette[int(colorIndex)];
    float variant = cellHash(cell, seed, 3.0);
    if (variant < LIGHT_VARIANT) {
      color = mix(color, vec3(1.0), LIGHTEN);
    }
    else if (variant >= DARK_VARIANT) {
      color *= DARKEN;
    }

    return CellStyle(color, mix(color, vec3(1.0), RESTING_LIGHTEN));
  }

  float cross2d(vec2 a, vec2 b) {
    return a.x * b.y - a.y * b.x;
  }

  // The trail texture covers the screen footprint on the floor, a parallelogram
  // (origin + u * axisU + v * axisV). Sampled once per cell, at its center.
  float cellTrail(vec2 cell) {
    vec2 offset = (cell + 0.5) * uCellSize - uTrailOrigin;
    float determinant = cross2d(uTrailAxisU, uTrailAxisV);
    vec2 uv = vec2(cross2d(offset, uTrailAxisV), cross2d(uTrailAxisU, offset))
      / (abs(determinant) < 0.00001 ? 0.00001 : determinant);
    float inside = step(0.0, min(uv.x, uv.y)) * step(max(uv.x, uv.y), 1.0);
    return texture2D(uTrailTexture, clamp(uv, 0.0, 1.0)).r * inside;
  }

  void main() {
    float visible;
    vec3 floorPosition = floorRayHit(0.0, visible);
    vec2 gridPosition = floorPosition.xz / uCellSize;
    vec2 cell = floor(gridPosition);

    // Slide change: fade the previous style out, then the next one in.
    CellStyle previous = cellStyle(cell, uPreviousIndex, uPreviousSeed, uPreviousCore);
    CellStyle next = cellStyle(cell, uNextIndex, uNextSeed, uNextCore);
    float delay = cellHash(cell, uNextSeed, 4.0) * SHIMMER_DELAY;
    float cellProgress = smoothstep(delay, delay + SHIMMER_DURATION, uTransition);
    float fadeOut = smoothstep(0.0, 0.5, cellProgress);
    float fadeIn = smoothstep(0.5, 1.0, cellProgress);
    vec3 restingColor = mix(mix(previous.restingColor, uFloorColor, fadeOut), next.restingColor, fadeIn);
    vec3 trailColor = mix(mix(previous.trailColor, uFloorColor, fadeOut), next.trailColor, fadeIn);
    vec3 color = mix(restingColor, trailColor, cellTrail(cell) * uTrailStrength);

    // Grid lines: pixel coverage of a line LINE_WIDTH pixels wide.
    vec2 gridDerivative = max(fwidth(gridPosition), vec2(0.0001));
    vec2 gridDistance = abs(fract(gridPosition - 0.5) - 0.5) / gridDerivative;
    float line = clamp(LINE_WIDTH * 0.5 + 0.5 - min(gridDistance.x, gridDistance.y), 0.0, LINE_WIDTH);
    gl_FragColor = vec4(mix(color, uGridColor, line * visible), 1.0);
    #include <colorspace_fragment>
  }
`
/**
 * Flat-shaded box: lighter top, base color on the sides. The front (+Z) face
 * shows a black-and-white video as a mask, from a dark shade (black) to the
 * top color (white). The video covers the face above `uVideoBottom`, the part
 * kept under the floor at rest. The top face can show the `uTitle` alpha mask
 * in the dark shade (u along +X, v toward -Z), the left (-X) face the
 * premultiplied `uIcon` texture (u along +Z, v up).
 */
export const volumeShaders = {
	vertexShader: /* glsl */ `
    varying vec2 vUv;
    varying vec3 vObjectNormal;

    void main() {
      vUv = uv;
      vObjectNormal = normal;
      gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }
  `,
	fragmentShader: /* glsl */ `
    uniform vec3 uColor;
    uniform sampler2D uVideo;
    uniform float uVideoBottom;
    uniform sampler2D uIcon;
    uniform bool uHasIcon;
    uniform sampler2D uTitle;
    uniform bool uHasTitle;

    varying vec2 vUv;
    varying vec3 vObjectNormal;

    void main() {
      vec3 color = uColor;
      vec3 topColor = mix(uColor, vec3(1.0), 0.5);
      vec3 darkColor = uColor * 0.45;
      if (vObjectNormal.y > 0.5) {
        color = topColor;
        if (uHasTitle) {
          color = mix(color, darkColor, texture2D(uTitle, vUv).a);
        }
      }
      else if (vObjectNormal.x < -0.5 && uHasIcon) {
        vec4 icon = texture2D(uIcon, vUv);
        color = color * (1.0 - icon.a) + icon.rgb;
      }
      else if (vObjectNormal.z > 0.5) {
        vec2 videoUv = vec2(vUv.x, (vUv.y - uVideoBottom) / (1.0 - uVideoBottom));
        // Video textures are stored without sRGB decoding.
        vec3 video = sRGBTransferEOTF(texture2D(uVideo, videoUv)).rgb;
        float mask = dot(video, vec3(0.2126, 0.7152, 0.0722)) * step(0.0, videoUv.y);
        color = mix(darkColor, topColor, mask);
      }
      gl_FragColor = vec4(color, 1.0);
      #include <colorspace_fragment>
    }
  `,
}
