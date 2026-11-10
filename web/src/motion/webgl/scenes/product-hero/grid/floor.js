import { DataTexture, Mesh, NearestFilter, PlaneGeometry, RGBAFormat, ShaderMaterial } from 'three'
import {
	CELL_SIZE,
	CORNER_RADIUS,
	FINE_CELL_SIZE,
	FINE_LATTICE,
	FLOOR_SIZE,
	LATTICE,
} from './layout.js'
/** Bottom of the hero cube. */
export const FLOOR_Y = -0.5
const glslFloat = (value) => value.toFixed(6)
const vertexShader = /* glsl */ `
  varying vec2 vWorldXZ;

  void main() {
    vec4 worldPosition = modelMatrix * vec4(position, 1.0);
    vWorldXZ = worldPosition.xz;
    gl_Position = projectionMatrix * viewMatrix * worldPosition;
  }
`
/**
 * The cell grid (with the fine one on the left), the lit cells, then the inbound and outbound routes.
 * Routes come from each lattice cell's links (see `layout.ts`). Line widths are in pixels.
 */
const fragmentShader = /* glsl */ `
  uniform vec3 uFloorColor;
  uniform vec3 uGridLineColor;
  uniform float uGridLineWidth;
  uniform float uFineGridOpacity;
  // Where the fine grid starts fading out and where it is gone, along x + z (screen right).
  uniform vec2 uFineGridFade;
  // Fine lattice. r: links (bits +X, -X, +Z, -Z), g: line opacity.
  uniform sampler2D uInboundMap;
  uniform vec3 uInboundLineColor;
  uniform float uInboundLineWidth;
  uniform float uInboundLineOpacity;
  // Cell lattice. r: outbound links, g: light, b: 1 on destination cells.
  uniform sampler2D uCellMap;
  uniform vec3 uOutboundLineColor;
  uniform float uOutboundLineWidth;
  uniform vec3 uOutboundHaloColor;
  uniform float uOutboundHaloWidth;
  uniform vec3 uCellIdleColor;
  uniform vec3 uCellLitColor;
  uniform float uCellLitOpacity;

  varying vec2 vWorldXZ;

  // Screen derivatives of the floor position, and world units per pixel along X and Z, set once in main().
  vec2 floorDx;
  vec2 floorDy;
  vec2 pixelSize;

  // World units per pixel along the screen gradient of dot(position, direction): exact on a plane under an orthographic camera.
  float unitsPerPixel(vec2 direction) {
    return max(length(vec2(dot(floorDx, direction), dot(floorDy, direction))), 0.00001);
  }

  float lineCoverage(float distancePx, float widthPx) {
    return 1.0 - smoothstep(widthPx * 0.5 - 0.5, widthPx * 0.5 + 0.5, distancePx);
  }

  float gridCoverage(float cellSize, float widthPx) {
    vec2 distancePx = abs(fract(vWorldXZ / cellSize + 0.5) - 0.5) * cellSize / pixelSize;
    return lineCoverage(min(distancePx.x, distancePx.y), widthPx);
  }

  // The data of the lattice cell around the fragment, and in offset the fragment position from the cell center.
  vec4 latticeCell(sampler2D map, float cellSize, float resolution, out vec2 offset) {
    vec2 cell = floor(vWorldXZ / cellSize);
    offset = vWorldXZ - (cell + 0.5) * cellSize;
    return texelFetch(map, ivec2(clamp(cell + resolution * 0.5, 0.0, resolution - 1.0)), 0);
  }

  // Routes through a lattice cell, from its links. offset: fragment position from the cell center.
  float routeCoverage(vec2 offset, int links, float widthPx) {
    int xLinks = links & 3;
    int zLinks = links >> 2;

    // One turn: a rounded corner, mirrored so that it links +X and +Z.
    if ((xLinks == 1 || xLinks == 2) && (zLinks == 1 || zLinks == 2)) {
      vec2 mirror = vec2(xLinks == 1 ? 1.0 : -1.0, zLinks == 1 ? 1.0 : -1.0);
      vec2 q = offset * mirror;
      float radius = ${glslFloat(CORNER_RADIUS)};
      float distancePx = 100000.0;
      if (q.x >= radius) distancePx = abs(q.y) / pixelSize.y;
      if (q.y >= radius) distancePx = min(distancePx, abs(q.x) / pixelSize.x);
      vec2 arc = q - radius;
      if (arc.x <= 0.0 && arc.y <= 0.0) {
        float arcDistance = length(arc);
        vec2 normal = mirror * arc / max(arcDistance, 0.00001);
        distancePx = min(distancePx, abs(arcDistance - radius) / unitsPerPixel(normal));
      }
      return lineCoverage(distancePx, widthPx);
    }

    // Otherwise half lines from the center to each linked side, with square ends half a width long so they join.
    float acrossX = lineCoverage(abs(offset.y) / pixelSize.y, widthPx);
    float acrossZ = lineCoverage(abs(offset.x) / pixelSize.x, widthPx);
    float coverage = 0.0;
    if ((links & 1) != 0) coverage = max(coverage, acrossX * lineCoverage(max(-offset.x, 0.0) / pixelSize.x, widthPx));
    if ((links & 2) != 0) coverage = max(coverage, acrossX * lineCoverage(max(offset.x, 0.0) / pixelSize.x, widthPx));
    if ((links & 4) != 0) coverage = max(coverage, acrossZ * lineCoverage(max(-offset.y, 0.0) / pixelSize.y, widthPx));
    if ((links & 8) != 0) coverage = max(coverage, acrossZ * lineCoverage(max(offset.y, 0.0) / pixelSize.y, widthPx));
    return coverage;
  }

  int linksOf(vec4 data) {
    return int(data.r * 255.0 + 0.5);
  }

  void main() {
    floorDx = dFdx(vWorldXZ);
    floorDy = dFdy(vWorldXZ);
    pixelSize = vec2(unitsPerPixel(vec2(1.0, 0.0)), unitsPerPixel(vec2(0.0, 1.0)));

    float fineGrid = uFineGridOpacity * (1.0 - smoothstep(uFineGridFade.x, uFineGridFade.y, vWorldXZ.x + vWorldXZ.y));
    vec3 color = mix(uFloorColor, uGridLineColor, gridCoverage(${glslFloat(FINE_CELL_SIZE)}, uGridLineWidth) * fineGrid);
    color = mix(color, uGridLineColor, gridCoverage(${glslFloat(CELL_SIZE)}, uGridLineWidth));

    // Lit cells cover the grid and the outbound halo, not the lines.
    vec2 cellOffset;
    vec4 cell = latticeCell(uCellMap, ${glslFloat(CELL_SIZE)}, ${glslFloat(LATTICE.resolution)}, cellOffset);
    int outboundLinks = linksOf(cell);
    color = mix(color, uCellIdleColor, cell.b);
    color = mix(color, uOutboundHaloColor, routeCoverage(cellOffset, outboundLinks, uOutboundHaloWidth));
    color = mix(color, uCellLitColor, cell.g * uCellLitOpacity);

    vec2 fineOffset;
    vec4 fine = latticeCell(uInboundMap, ${glslFloat(FINE_CELL_SIZE)}, ${glslFloat(FINE_LATTICE.resolution)}, fineOffset);
    float inbound = routeCoverage(fineOffset, linksOf(fine), uInboundLineWidth);
    color = mix(color, uInboundLineColor, inbound * fine.g * uInboundLineOpacity);

    color = mix(color, uOutboundLineColor, routeCoverage(cellOffset, outboundLinks, uOutboundLineWidth));

    gl_FragColor = vec4(color, 1.0);
    #include <colorspace_fragment>
  }
`
/** An RGBA texel per lattice cell, read with texelFetch. */
function createLatticeTexture({ resolution }) {
	const data = new Uint8Array(resolution * resolution * 4)
	const texture = new DataTexture(data, resolution, resolution, RGBAFormat)
	texture.minFilter = NearestFilter
	texture.magFilter = NearestFilter
	return { data, texture }
}
/** The floor of a layout. `setLight` and `commitLights` light its cells up. */
export function createFloor({ inbound, outbound }, uniforms) {
	const inboundMap = createLatticeTexture(FINE_LATTICE)
	inbound.links.forEach((links, index) => {
		inboundMap.data[index * 4] = links
		inboundMap.data[index * 4 + 1] = Math.round(inbound.strengths[index] * 255)
	})
	inboundMap.texture.needsUpdate = true
	const cellMap = createLatticeTexture(LATTICE)
	outbound.links.forEach((links, index) => {
		cellMap.data[index * 4] = links
	})
	for (const index of outbound.destinations) cellMap.data[index * 4 + 2] = 255
	cellMap.texture.needsUpdate = true
	const mesh = new Mesh(
		new PlaneGeometry(FLOOR_SIZE, FLOOR_SIZE),
		new ShaderMaterial({
			uniforms: {
				...uniforms,
				uInboundMap: { value: inboundMap.texture },
				uCellMap: { value: cellMap.texture },
			},
			vertexShader,
			fragmentShader,
			// Dots are screen-facing quads on the floor: only the cube hides them.
			depthWrite: false,
		}),
	)
	mesh.rotation.x = -Math.PI / 2
	mesh.position.y = FLOOR_Y
	return {
		mesh,
		/** Light (0..1) of the cell at `index`, shown on the next `commitLights`. */
		setLight(index, light) {
			cellMap.data[index * 4 + 1] = Math.round(Math.min(Math.max(light, 0), 1) * 255)
		},
		commitLights() {
			cellMap.texture.needsUpdate = true
		},
	}
}
