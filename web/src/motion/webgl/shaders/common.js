import { BufferAttribute, BufferGeometry, Mesh } from 'three'
/** `float aastep(float sdf)`: 0 below zero, 1 above, smoothed over ~1px. */
export const aastep = /* glsl */ `
  float aastep(float sdf) {
    float width = max(fwidth(sdf), 0.0001);
    return smoothstep(-width, width, sdf);
  }
`
/**
 * 5×5 grid of squares drawn on a cube face (product cubes, Sandbox floor).
 * Needs `aastep`. Cells are 0..4 from bottom-left; which ones are black comes
 * from a mask built by `parseFacePattern` in `palette.ts`.
 */
export const faceGrid = /* glsl */ `
  const float FACE_GRID_GAP = 0.03;
  const float FACE_GRID_SQUARE = (1.0 - FACE_GRID_GAP * 6.0) / 5.0;
  const float FACE_GRID_STRIDE = FACE_GRID_SQUARE + FACE_GRID_GAP;

  vec2 faceGridCell(vec2 uv) {
    return clamp(floor((uv - FACE_GRID_GAP) / FACE_GRID_STRIDE), 0.0, 4.0);
  }

  // 0..1 position inside the square of the given cell.
  vec2 faceGridCellUv(vec2 uv, vec2 cell) {
    return (uv - FACE_GRID_GAP - cell * FACE_GRID_STRIDE) / FACE_GRID_SQUARE;
  }

  // 1 on the gaps and frame, 0 inside the squares. squareScale < 1 shrinks the squares.
  float faceGridBorder(vec2 uv, float squareScale) {
    vec2 inner = uv - FACE_GRID_GAP;
    vec2 cellPosition = mod(max(inner, 0.0), FACE_GRID_STRIDE);
    vec2 squareDistance = abs(cellPosition - FACE_GRID_SQUARE * 0.5) - FACE_GRID_SQUARE * squareScale * 0.5;
    float insideSquare = 1.0 - aastep(max(squareDistance.x, squareDistance.y));
    vec2 frameDistance = min(inner, 1.0 - FACE_GRID_GAP - uv);
    float insideFrame = aastep(min(frameDistance.x, frameDistance.y));
    return 1.0 - insideSquare * insideFrame;
  }

  // 1 when the cell is black in the mask (25 bits, row-major from the top row).
  float patternHole(vec2 cell, int mask) {
    int bit = int(cell.x) + 5 * (4 - int(cell.y));
    return float((mask >> bit) & 1);
  }
`
/** A single triangle covering the viewport (no diagonal seam, fewer vertices than a quad). */
export function createFullscreenMesh(material) {
	const geometry = new BufferGeometry()
	geometry.setAttribute(
		'position',
		new BufferAttribute(new Float32Array([-1, -1, 0, 3, -1, 0, -1, 3, 0]), 3),
	)
	const mesh = new Mesh(geometry, material)
	mesh.frustumCulled = false
	return mesh
}
/**
 * Infinite floor on a fullscreen triangle: each vertex is unprojected to a
 * near/far world-space segment so the fragment shader can intersect the view
 * ray with any horizontal plane (`floorRayHit`). Uniforms: `createFloorRayUniforms`.
 */
export const floorRayVertexShader = /* glsl */ `
  uniform mat4 uInverseProjectionMatrix;
  uniform mat4 uCameraMatrixWorld;

  varying vec3 vNearWorld;
  varying vec3 vFarWorld;

  void main() {
    vec4 nearView = uInverseProjectionMatrix * vec4(position.xy, -1.0, 1.0);
    vec4 farView = uInverseProjectionMatrix * vec4(position.xy, 1.0, 1.0);
    vNearWorld = (uCameraMatrixWorld * (nearView / nearView.w)).xyz;
    vFarWorld = (uCameraMatrixWorld * (farView / farView.w)).xyz;
    gl_Position = vec4(position.xy, 1.0, 1.0);
  }
`
/** Fragment-side helper for `floorRayVertexShader`. `visible` is 0 when the hit is outside the near/far range. */
export const floorRayHit = /* glsl */ `
  varying vec3 vNearWorld;
  varying vec3 vFarWorld;

  vec3 floorRayHit(float height, out float visible) {
    vec3 direction = vFarWorld - vNearWorld;
    float t = (height - vNearWorld.y) / min(direction.y, -0.0001);
    visible = step(0.0, t) * step(t, 1.0);
    return vNearWorld + direction * t;
  }
`
export function createFloorRayUniforms(camera) {
	return {
		uInverseProjectionMatrix: { value: camera.projectionMatrixInverse },
		uCameraMatrixWorld: { value: camera.matrixWorld },
	}
}
