/** Floor cells are half a cube wide: the hero cube covers 2×2 of them. Outbound routes light them up. */
export const CELL_SIZE = 0.5
/** Inbound routes run on a denser lattice, of half cells. */
export const FINE_CELL_SIZE = CELL_SIZE / 2
export const FLOOR_SIZE = 16
/** Route turns are quarter circles this wide, on both lattices. */
export const CORNER_RADIUS = FINE_CELL_SIZE / 2
/**
 * Lattice cells link to the neighbors their routes run to, one bit per side.
 * The floor shader draws the routes from these bits, as in `routeCoverage`.
 */
const LINK_PLUS_X = 1
const LINK_MINUS_X = 2
const LINK_PLUS_Z = 4
const LINK_MINUS_Z = 8
const latticeOf = (cellSize) => ({
	cellSize,
	resolution: Math.round(FLOOR_SIZE / cellSize),
})
export const LATTICE = latticeOf(CELL_SIZE)
export const FINE_LATTICE = latticeOf(FINE_CELL_SIZE)
/** Row-major index of the cell around a floor point, as in the floor textures; -1 off the floor. */
export function cellIndex({ cellSize, resolution }, [x, z]) {
	const i = Math.floor(x / cellSize) + resolution / 2
	const j = Math.floor(z / cellSize) + resolution / 2
	return i < 0 || j < 0 || i >= resolution || j >= resolution ? -1 : j * resolution + i
}
/** True when a cell's routes make a single turn through it, drawn as a rounded corner. */
const isCorner = (links) => {
	const xLinks = links & 3
	const zLinks = links >> 2
	return (xLinks === 1 || xLinks === 2) && (zLinks === 1 || zLinks === 2)
}
/** Landscape visual, at and above the `md` breakpoint: about 5.9 × 2 units of screen. */
export const DESKTOP_LAYOUT = {
	inbound: { area: { sMin: -4.6, dMin: -1.9, dMax: 3.9 }, count: 48, seed: 7 },
	dotScale: 1,
	// Out of the grid face along a single trunk, which runs on under the product subnav and branches
	// down to the cells below it, on to the bottom and right edges, and up, through four cells, to the
	// top edge above the cube's right corner.
	outbound: {
		branches: [
			[
				[0.25, 0.25],
				[0.25, 0.75],
				[2.75, 0.75],
				[2.75, 1.25],
			],
			[
				[1.75, 0.75],
				[1.75, 2.25],
			],
			[
				[0.75, 0.75],
				[0.75, 2.25],
			],
			[
				[1.25, 0.75],
				[1.25, 2.75],
			],
			[
				[1.25, 0.75],
				[1.25, 0.25],
				[1.75, 0.25],
				[1.75, -0.25],
				[2.25, -0.25],
				[2.25, -0.75],
			],
		],
		destinations: [
			[0.75, 1.25],
			[0.75, 2.25],
			[1.25, 1.75],
			[1.25, 2.75],
			[1.75, 1.25],
			[1.75, 2.25],
			[2.25, 0.75],
			[2.75, 1.25],
			[1.25, 0.25],
			[1.75, 0.25],
			[1.75, -0.25],
			[2.25, -0.25],
			[2.25, -0.75],
		],
	},
}
/** Portrait visual below the `md` breakpoint, about 3.2 × 4 units: the cells stand above and below the cube's right. */
export const MOBILE_LAYOUT = {
	inbound: { area: { sMin: -2.7, dMin: -4.3, dMax: 6.3 }, count: 26, seed: 11 },
	dotScale: 0.75,
	// Out of the back along a trunk branching up to the cells above, the farthest one on towards the
	// top; out of the grid face along one branching down to the cells below, out to the bottom edge;
	// and to the cells right of the grid face, out to the right edge.
	outbound: {
		branches: [
			[
				[0.25, 0.25],
				[0.25, 0.75],
				[1.25, 0.75],
			],
			[
				[0.25, -0.25],
				[2.25, -0.25],
				[2.25, -1.75],
				[3.25, -1.75],
			],
			[
				[1.75, -0.25],
				[1.75, -0.75],
			],
			[
				[-0.25, 0.25],
				[-0.25, 2.25],
				[-1.75, 2.25],
			],
			[
				[-0.25, 1.25],
				[-0.75, 1.25],
			],
			[
				[-0.25, 1.75],
				[-1.25, 1.75],
			],
		],
		destinations: [
			[0.75, 0.75],
			[1.25, 0.75],
			[1.75, -0.75],
			[2.25, -1.75],
			[3.25, -1.75],
			[-0.75, 1.25],
			[-1.25, 1.75],
			[-1.75, 2.25],
		],
	},
}
/** Deterministic 0..1 pseudo-random (mulberry32), so the inbound routes are the same on every load. */
function seededRandom(seed) {
	let state = seed
	return () => {
		state = (state + 0x6d2b79f5) | 0
		let value = Math.imul(state ^ (state >>> 15), 1 | state)
		value = (value + Math.imul(value ^ (value >>> 7), 61 | value)) ^ value
		return ((value ^ (value >>> 14)) >>> 0) / 4294967296
	}
}
/** Fine cells the cube stands on, along either axis: the lanes routes enter it by. */
const CUBE_LANES = [-2, -1, 0, 1]
/** Most turns of an inbound route before its final run into the cube. */
const MAX_INBOUND_TURNS = 6
/** Fine cells of the final straight run into a cube face, at least and at most. */
const APPROACH = [1, 6]
/**
 * Inbound routes from the edges of `area` into the cube's -X or -Z face. Each one heads
 * straight for the cube along the fine lattice, in a few turns that stay inside the area, then
 * runs into a face in one of the four lanes the cube covers. Routes cross and merge freely.
 */
function generateInbound({ area: { sMin, dMin, dMax }, count, seed }) {
	const random = seededRandom(seed)
	const randomInt = (min, max) => min + Math.floor(random() * (max - min + 1))
	const { cellSize } = FINE_LATTICE
	const toCell = (s, d) => [Math.floor((s + d) / 2 / cellSize), Math.floor((s - d) / 2 / cellSize)]
	const inArea = ([i, j]) => {
		const s = (i + j + 1) * cellSize
		const d = (i - j) * cellSize
		return s >= sMin - cellSize && s <= 0 && d >= dMin - cellSize && d <= dMax + cellSize
	}
	const routes = []
	/** Line opacity of each route, so the network has depth. */
	const strengths = []
	while (routes.length < count) {
		// A start on the left, top or bottom edge, as likely as the edge is long.
		const leftLength = dMax - dMin
		const sideLength = -sMin
		let along = random() * (leftLength + 2 * sideLength)
		let start
		/** Axis of the first run, heading into the area: 0 for X, 1 for Z. */
		let axis
		if (along < leftLength) {
			start = toCell(sMin, dMin + along)
			axis = random() < 0.5 ? 0 : 1
		} else if ((along -= leftLength) < sideLength) {
			// From the top, +X would head up and out of view.
			start = toCell(sMin + along, dMax)
			axis = 1
		} else {
			// From the bottom, +Z would head down and out of view.
			start = toCell(sMin + along - sideLength, dMin)
			axis = 0
		}
		// The face the route enters by, along +X (-X face) or +Z (-Z face), if it can get there.
		const lane = CUBE_LANES[randomInt(0, CUBE_LANES.length - 1)]
		const approach = -3 - randomInt(...APPROACH)
		const faces = [
			start[0] <= approach ? { from: [approach, lane], to: [-1, lane] } : undefined,
			start[1] <= approach ? { from: [lane, approach], to: [lane, -1] } : undefined,
		].filter((face) => face !== undefined)
		const face = faces[randomInt(0, faces.length - 1)]
		if (!face) continue
		const cells = [start]
		const cell = [...start]
		for (let turns = 0; cell[0] !== face.from[0] || cell[1] !== face.from[1]; axis = 1 - axis) {
			const remaining = face.from[axis] - cell[axis]
			if (remaining === 0) continue
			// A random share of the way left on this axis, or all of it once the other axis is done.
			let step = remaining
			if (face.from[1 - axis] !== cell[1 - axis] && turns < MAX_INBOUND_TURNS) {
				const steps = Array.from(
					{ length: Math.abs(remaining) },
					(_, n) => (n + 1) * Math.sign(remaining),
				)
				const inside = steps.filter((option) => {
					const next = [...cell]
					next[axis] += option
					return inArea(next)
				})
				// Short runs are likelier, for more turns.
				if (inside.length > 0) step = inside[Math.floor(random() ** 1.6 * inside.length)]
			}
			cell[axis] += step
			cells.push([...cell])
			turns += 1
		}
		// Runs with no room for a turn can leave the area, towards the cube's right: start over.
		if (!cells.every(inArea)) continue
		cells.push(face.to)
		routes.push(
			withoutStraightPoints(cells).map(([i, j]) => [(i + 0.5) * cellSize, (j + 0.5) * cellSize]),
		)
		strengths.push(0.45 + random() * 0.55)
	}
	return { routes, strengths }
}
/** Drops the points a route runs straight through. */
function withoutStraightPoints(points) {
	return points.filter((point, index) => {
		const previous = points[index - 1]
		const next = points[index + 1]
		if (!previous || !next) return true
		return (
			(previous[0] !== point[0] || point[0] !== next[0]) &&
			(previous[1] !== point[1] || point[1] !== next[1])
		)
	})
}
/** Each destination's route: back from it along the branches into the cube, then turned around, through its turns. */
function treeRoutes({ branches, destinations }) {
	const { cellSize } = LATTICE
	/** The cell each one is reached from, by `cellIndex`. */
	const parents = new Map()
	for (const branch of branches) {
		for (let index = 1; index < branch.length; index += 1) {
			const [ax, az] = branch[index - 1]
			const [bx, bz] = branch[index]
			const stepX = Math.sign(bx - ax) * cellSize
			const stepZ = Math.sign(bz - az) * cellSize
			const count = Math.round(Math.hypot(bx - ax, bz - az) / cellSize)
			for (let step = 1; step <= count; step += 1) {
				const cell = [ax + stepX * step, az + stepZ * step]
				parents.set(cellIndex(LATTICE, cell), [cell[0] - stepX, cell[1] - stepZ])
			}
		}
	}
	return destinations.map((destination) => {
		const cells = [destination]
		// Bounded, in case a branch runs back over an earlier one.
		while (cells.length <= parents.size) {
			const parent = parents.get(cellIndex(LATTICE, cells[0]))
			if (!parent) break
			cells.unshift(parent)
		}
		return withoutStraightPoints(cells)
	})
}
/** Each cell's links to the neighbors routes run to, in `cellIndex` order. */
function linkRoutes(lattice, routes) {
	const links = new Uint8Array(lattice.resolution ** 2)
	const link = (point, bit) => {
		const index = cellIndex(lattice, point)
		if (index >= 0) links[index] |= bit
	}
	for (const route of routes) {
		for (let index = 1; index < route.length; index += 1) {
			const [ax, az] = route[index - 1]
			const [bx, bz] = route[index]
			const stepX = Math.sign(bx - ax) * lattice.cellSize
			const stepZ = Math.sign(bz - az) * lattice.cellSize
			const forward =
				stepX > 0 ? LINK_PLUS_X : stepX < 0 ? LINK_MINUS_X : stepZ > 0 ? LINK_PLUS_Z : LINK_MINUS_Z
			const backward = forward ^ (forward < LINK_PLUS_Z ? 3 : 12)
			const count = Math.round(Math.hypot(bx - ax, bz - az) / lattice.cellSize)
			for (let step = 0; step < count; step += 1) {
				link([ax + stepX * step, az + stepZ * step], forward)
				link([ax + stepX * (step + 1), az + stepZ * (step + 1)], backward)
			}
		}
	}
	return links
}
const ARC_SAMPLES = 8
/** A route with its turns rounded where the floor rounds them: in cells where it is the only one turning. */
function tracePath(lattice, links, route) {
	const points = [route[0]]
	for (let index = 1; index < route.length - 1; index += 1) {
		const corner = route[index]
		const inX = Math.sign(corner[0] - route[index - 1][0])
		const inZ = Math.sign(corner[1] - route[index - 1][1])
		const outX = Math.sign(route[index + 1][0] - corner[0])
		const outZ = Math.sign(route[index + 1][1] - corner[1])
		if (!isCorner(links[cellIndex(lattice, corner)])) {
			points.push(corner)
			continue
		}
		// Quarter circle from CORNER_RADIUS before the turn to CORNER_RADIUS after it.
		const centerX = corner[0] + (outX - inX) * CORNER_RADIUS
		const centerZ = corner[1] + (outZ - inZ) * CORNER_RADIUS
		for (let sample = 0; sample <= ARC_SAMPLES; sample += 1) {
			const angle = (sample / ARC_SAMPLES) * (Math.PI / 2)
			const back = Math.cos(angle) * CORNER_RADIUS
			const ahead = Math.sin(angle) * CORNER_RADIUS
			points.push([centerX - outX * back + inX * ahead, centerZ - outZ * back + inZ * ahead])
		}
	}
	points.push(route[route.length - 1])
	const distances = points.map(() => 0)
	for (let index = 1; index < points.length; index += 1) {
		const [ax, az] = points[index - 1]
		const [bx, bz] = points[index]
		distances[index] = distances[index - 1] + Math.hypot(bx - ax, bz - az)
	}
	return { points, distances, length: distances[distances.length - 1] }
}
/** Writes the point `distance` along `path` into `target`. */
export function pointAt({ points, distances }, distance, target) {
	let low = 0
	let high = distances.length - 1
	while (high - low > 1) {
		const middle = (low + high) >> 1
		if (distances[middle] <= distance) low = middle
		else high = middle
	}
	const [ax, az] = points[low]
	const [bx, bz] = points[high]
	const span = distances[high] - distances[low]
	const t = span > 0 ? Math.min(Math.max((distance - distances[low]) / span, 0), 1) : 0
	target[0] = ax + (bx - ax) * t
	target[1] = az + (bz - az) * t
	return target
}
/** What the floor and the dots need of a layout. */
export function prepareLayout(layout) {
	const inbound = generateInbound(layout.inbound)
	const inboundLinks = linkRoutes(FINE_LATTICE, inbound.routes)
	const outbound = treeRoutes(layout.outbound)
	const outboundLinks = linkRoutes(LATTICE, outbound)
	// The strongest route through a fine cell sets its line opacity.
	const inboundStrengths = new Float32Array(inboundLinks.length)
	inbound.routes.forEach((route, routeIndex) => {
		const strength = inbound.strengths[routeIndex]
		for (let index = 1; index < route.length; index += 1) {
			const [ax, az] = route[index - 1]
			const [bx, bz] = route[index]
			const count = Math.round(Math.hypot(bx - ax, bz - az) / FINE_CELL_SIZE)
			for (let step = 0; step <= count; step += 1) {
				const cell = cellIndex(FINE_LATTICE, [
					ax + ((bx - ax) * step) / count,
					az + ((bz - az) * step) / count,
				])
				if (cell >= 0) inboundStrengths[cell] = Math.max(inboundStrengths[cell], strength)
			}
		}
	})
	return {
		dotScale: layout.dotScale,
		inbound: {
			links: inboundLinks,
			strengths: inboundStrengths,
			paths: inbound.routes.map((route) => tracePath(FINE_LATTICE, inboundLinks, route)),
		},
		outbound: {
			links: outboundLinks,
			paths: outbound.map((route) => tracePath(LATTICE, outboundLinks, route)),
			/** Cell index of each route's destination. */
			destinations: outbound.map((route) => cellIndex(LATTICE, route[route.length - 1])),
		},
	}
}
