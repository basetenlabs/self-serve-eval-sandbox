import { Color, Vector2 } from '../../../../lib/three.js'
import { getProduct } from '../../../palette.js'
import { shuffle } from '../../../utils/random.js'
import { createHeroProductCube, defineProductHeroScene, isPortraitHero } from '../shared.js'
import { createDots } from './dots.js'
import { createFloor, FLOOR_Y } from './floor.js'
import {
	cellIndex,
	DESKTOP_LAYOUT,
	LATTICE,
	MOBILE_LAYOUT,
	pointAt,
	prepareLayout,
} from './layout.js'
const FLOOR_COLOR = '#F5F3F8'
/** Dots sit just above the floor, so it never hides them. */
const DOT_Y = FLOOR_Y + 0.001
/** Inbound dots per unit of route at most: the density setting shows a share of them. */
const MAX_INBOUND_DENSITY = 3
/** Outbound requests on their way at once. */
const MAX_REQUESTS = 32
/** Dots in the trail behind each outbound request. */
const TRAIL_DOTS = 10
/** How long a destination cell takes to light up when a request reaches it (s). */
const ARRIVAL_RISE = 0.12
/** How long a request's dot takes to vanish in its destination cell (s). */
const DOT_VANISH = 0.25
const easeOutCubic = (t) => 1 - (1 - t) ** 3
/**
 * Grid (purple): the hero cube on a cell grid, as a router. On the left, requests pour in from every
 * side: small dots on a dense tangle of routes, along the cells of a finer grid. On the right, the
 * cube sends them out in an orderly stream: one at a time, along cell centers, to destination cells
 * out to the edges of the view. Cells light up as requests pass over them and flash when one
 * arrives; hovered cells light up too. The routes follow the desktop or the mobile layout, switched
 * at the same breakpoint as the camera zoom.
 * @param {import('../shared.js').ProductHeroOptions} [options]
 */
export function createGridHeroScene({
	product = getProduct('grid'),
	videoUrl,
	zoom,
	trailFade,
} = {}) {
	return defineProductHeroScene({
		zoom,
		name: 'Product Hero · Grid',
		create(context) {
			const { scene, pointer, size, gui } = context
			scene.background = new Color(FLOOR_COLOR)
			const parameters = {
				/** Inbound dots per unit of route. */
				inboundDensity: 1.6,
				/** World units per second, give or take a quarter per dot. */
				inboundSpeed: 0.7,
				inboundDotSize: 4,
				outboundSpeed: 1.6,
				/** Time between two requests leaving the cube (s). */
				emitInterval: 0.35,
				outboundDotSize: 7,
				/** Length of the trail behind outbound dots (world units). */
				outboundTrail: 0.35,
				/** Cell light while a request passes over it. */
				passLight: 0.3,
				/** How fast cells light up under a request, then fade back after it (1/s). */
				passRise: 25,
				passFade: 3,
				/** Destination cell light when a request reaches it. */
				arrivalLight: 1,
				/** How fast destination cells fade back after a request (1/s). */
				arrivalFade: 1.5,
				hoverLight: 0.5,
				/** How fast cells follow the pointer (1/s). */
				hoverLerp: 10,
			}
			// Shared by both layouts' floors and dots, so the debug panel drives whichever is showing.
			const floorUniforms = {
				uFloorColor: { value: new Color(FLOOR_COLOR) },
				uGridLineColor: { value: new Color('#E3DCEA') },
				uGridLineWidth: { value: 1 },
				uFineGridOpacity: { value: 0.55 },
				uFineGridFade: { value: new Vector2(-0.5, 0.5) },
				uInboundLineColor: { value: new Color('#B68BDC') },
				uInboundLineWidth: { value: 1.25 },
				uInboundLineOpacity: { value: 0.9 },
				uOutboundLineColor: { value: new Color('#A779CE') },
				uOutboundLineWidth: { value: 1.5 },
				uOutboundHaloColor: { value: new Color('#EAE1F3') },
				uOutboundHaloWidth: { value: 9 },
				uCellIdleColor: { value: new Color('#E8DBF5') },
				uCellLitColor: { value: new Color(product.color) },
				uCellLitOpacity: { value: 0.5 },
			}
			const viewport = { value: new Vector2(size.width, size.height) }
			const edgeSoftness = { value: 0.35 }
			const inboundDotUniforms = {
				uViewportPx: viewport,
				uColor: { value: new Color('#A66BDE') },
				uEdgeSoftness: edgeSoftness,
			}
			const outboundDotUniforms = {
				uViewportPx: viewport,
				uColor: { value: new Color(product.color) },
				uEdgeSoftness: edgeSoftness,
			}
			const cube = createHeroProductCube(context, {
				product,
				gridCellColor: product.background,
				videoUrl,
				trailFade,
			})
			/** A layout on the floor: its routes and cells, and the dots running on them. */
			const createNetwork = (layout) => {
				const floor = createFloor(layout, floorUniforms)
				scene.add(floor.mesh)
				// Inbound dots loop along their routes, each at its own pace.
				const inboundDots = layout.inbound.paths.flatMap((path, route) =>
					Array.from({ length: Math.ceil(path.length * MAX_INBOUND_DENSITY) }, () => ({
						route,
						distance: Math.random() * path.length,
						speed: 0.75 + Math.random() * 0.5,
						size: 0.6 + Math.random() * 0.8,
						pulsePhase: Math.random() * Math.PI * 2,
						/** Shown while below the density setting, as a share of the most. */
						rank: Math.random(),
					})),
				)
				const inbound = createDots(inboundDots.length, inboundDotUniforms)
				const outbound = createDots(MAX_REQUESTS * (1 + TRAIL_DOTS), outboundDotUniforms)
				outbound.mesh.renderOrder = 1
				scene.add(inbound.mesh, outbound.mesh)
				const cellCount = LATTICE.resolution ** 2
				const passLights = new Float32Array(cellCount)
				const hoverLights = new Float32Array(cellCount)
				const arrivedAt = new Float32Array(cellCount).fill(-Infinity)
				const occupied = new Uint8Array(cellCount)
				const requests = []
				/** Routes still to be served in this round, so that each one gets its share in turn. */
				let queue = []
				let nextEmission = 0
				const point = [0, 0]
				const nextRoute = () => {
					if (queue.length === 0) {
						const last = requests[requests.length - 1]?.route
						queue = shuffle(layout.outbound.paths.map((_, index) => index))
						// Never the same route twice in a row, across rounds.
						if (queue.length > 1 && queue[queue.length - 1] === last) queue.unshift(queue.pop())
					}
					return queue.pop()
				}
				return {
					floor: floor.mesh,
					setVisible(visible) {
						floor.mesh.visible = visible
						inbound.mesh.visible = visible
						outbound.mesh.visible = visible
					},
					update({ delta, elapsed }, hit) {
						for (const dot of inboundDots) {
							const path = layout.inbound.paths[dot.route]
							dot.distance =
								(dot.distance + delta * parameters.inboundSpeed * dot.speed) % path.length
							if (dot.rank * MAX_INBOUND_DENSITY >= parameters.inboundDensity) continue
							pointAt(path, dot.distance, point)
							const pulse = 0.5 + 0.5 * Math.sin(elapsed * 6 + dot.pulsePhase)
							const size =
								parameters.inboundDotSize * layout.dotScale * dot.size * (0.75 + 0.5 * pulse)
							inbound.add(point[0], DOT_Y, point[1], size, 0.85)
						}
						inbound.commit()
						// Requests leave the cube at a steady pace: Grid keeps the traffic in order.
						if (elapsed >= nextEmission) {
							if (requests.length < MAX_REQUESTS) requests.push({ route: nextRoute(), distance: 0 })
							nextEmission = Math.max(nextEmission + parameters.emitInterval, elapsed)
						}
						occupied.fill(0)
						const trail = parameters.outboundTrail
						for (let index = requests.length - 1; index >= 0; index -= 1) {
							const request = requests[index]
							const path = layout.outbound.paths[request.route]
							// The distance runs on past the destination, for the trail to catch up with the dot.
							request.distance += delta * parameters.outboundSpeed
							if (request.arrivedAt === undefined && request.distance >= path.length) {
								request.arrivedAt = elapsed
								arrivedAt[layout.outbound.destinations[request.route]] = elapsed
							}
							const vanish =
								request.arrivedAt === undefined
									? 0
									: Math.min((elapsed - request.arrivedAt) / DOT_VANISH, 1)
							if (vanish >= 1 && request.distance - trail >= path.length) {
								requests.splice(index, 1)
								continue
							}
							pointAt(path, request.distance, point)
							const cell = cellIndex(LATTICE, point)
							if (cell >= 0) occupied[cell] = 1
							const size = parameters.outboundDotSize * layout.dotScale
							outbound.add(point[0], DOT_Y, point[1], size * (1 - easeOutCubic(vanish)), 1)
							// Smaller, fainter dots behind, which vanish into the destination cell.
							for (let dot = 1; dot <= TRAIL_DOTS; dot += 1) {
								const behind = dot / TRAIL_DOTS
								const distance = request.distance - behind * trail
								if (distance < 0) break
								if (distance >= path.length) continue
								pointAt(path, distance, point)
								outbound.add(
									point[0],
									DOT_Y,
									point[1],
									size * (0.8 - 0.6 * behind),
									0.6 * (1 - behind),
								)
							}
						}
						outbound.commit()
						// The pointer lights the cell it is over, on the cube's right.
						let hoveredCell = -1
						if (hit?.object === floor.mesh) {
							const { x, z } = hit.point
							const underCube = Math.abs(x) < 0.5 && Math.abs(z) < 0.5
							if (x + z > 0 && !underCube) hoveredCell = cellIndex(LATTICE, [x, z])
						}
						// Frame-rate independent easing: requests light cells quickly, which then fade back slowly.
						const passRise = 1 - Math.exp(-delta * parameters.passRise)
						const passFade = Math.exp(-delta * parameters.passFade)
						const hoverEase = 1 - Math.exp(-delta * parameters.hoverLerp)
						for (let index = 0; index < cellCount; index += 1) {
							const pass = occupied[index]
								? passLights[index] + (1 - passLights[index]) * passRise
								: passLights[index] * passFade
							passLights[index] = pass
							hoverLights[index] +=
								((index === hoveredCell ? 1 : 0) - hoverLights[index]) * hoverEase
							// A quick flash on arrival, then an exponential fade.
							const time = elapsed - arrivedAt[index]
							const arrival =
								time < ARRIVAL_RISE
									? easeOutCubic(time / ARRIVAL_RISE)
									: Math.exp(-(time - ARRIVAL_RISE) * parameters.arrivalFade)
							floor.setLight(
								index,
								Math.max(
									pass * parameters.passLight,
									arrival * parameters.arrivalLight,
									hoverLights[index] * parameters.hoverLight,
								),
							)
						}
						floor.commitLights()
					},
				}
			}
			const networks = {
				desktop: createNetwork(prepareLayout(DESKTOP_LAYOUT)),
				mobile: createNetwork(prepareLayout(MOBILE_LAYOUT)),
			}
			let network = networks.desktop
			const pickNetwork = () => {
				network = isPortraitHero() ? networks.mobile : networks.desktop
				networks.desktop.setVisible(network === networks.desktop)
				networks.mobile.setVisible(network === networks.mobile)
			}
			pickNetwork()
			const inboundFolder = gui.addFolder({ title: 'Inbound' })
			inboundFolder.addBinding(parameters, 'inboundDensity', {
				label: 'Density (dots/unit)',
				min: 0,
				max: MAX_INBOUND_DENSITY,
				step: 0.05,
			})
			inboundFolder.addBinding(parameters, 'inboundSpeed', {
				label: 'Speed (units/s)',
				min: 0,
				max: 4,
				step: 0.05,
			})
			inboundFolder.addBinding(parameters, 'inboundDotSize', {
				label: 'Dot size (px)',
				min: 1,
				max: 12,
				step: 0.25,
			})
			inboundFolder.addBinding(floorUniforms.uInboundLineWidth, 'value', {
				label: 'Line width (px)',
				min: 0.5,
				max: 4,
				step: 0.25,
			})
			inboundFolder.addBinding(floorUniforms.uInboundLineOpacity, 'value', {
				label: 'Line opacity',
				min: 0,
				max: 1,
				step: 0.01,
			})
			const outboundFolder = gui.addFolder({ title: 'Outbound' })
			outboundFolder.addBinding(parameters, 'outboundSpeed', {
				label: 'Speed (units/s)',
				min: 0.25,
				max: 6,
				step: 0.05,
			})
			outboundFolder.addBinding(parameters, 'emitInterval', {
				label: 'Emit interval (s)',
				min: 0.1,
				max: 2,
				step: 0.05,
			})
			outboundFolder.addBinding(parameters, 'outboundDotSize', {
				label: 'Dot size (px)',
				min: 1,
				max: 16,
				step: 0.25,
			})
			outboundFolder.addBinding(parameters, 'outboundTrail', {
				label: 'Trail (units)',
				min: 0,
				max: 1.5,
				step: 0.01,
			})
			outboundFolder.addBinding(floorUniforms.uOutboundLineWidth, 'value', {
				label: 'Line width (px)',
				min: 0.5,
				max: 6,
				step: 0.25,
			})
			outboundFolder.addBinding(floorUniforms.uOutboundHaloWidth, 'value', {
				label: 'Halo width (px)',
				min: 0,
				max: 24,
				step: 0.5,
			})
			const cellsFolder = gui.addFolder({ title: 'Cells' })
			cellsFolder.addBinding(floorUniforms.uCellLitOpacity, 'value', {
				label: 'Lit opacity',
				min: 0,
				max: 1,
				step: 0.01,
			})
			cellsFolder.addBinding(parameters, 'passLight', {
				label: 'Pass light',
				min: 0,
				max: 1,
				step: 0.01,
			})
			cellsFolder.addBinding(parameters, 'passFade', {
				label: 'Pass fade (1/s)',
				min: 0.2,
				max: 10,
				step: 0.1,
			})
			cellsFolder.addBinding(parameters, 'arrivalLight', {
				label: 'Arrival light',
				min: 0,
				max: 1,
				step: 0.01,
			})
			cellsFolder.addBinding(parameters, 'arrivalFade', {
				label: 'Arrival fade (1/s)',
				min: 0.2,
				max: 10,
				step: 0.1,
			})
			cellsFolder.addBinding(parameters, 'hoverLight', {
				label: 'Hover light',
				min: 0,
				max: 1,
				step: 0.01,
			})
			const floorFolder = gui.addFolder({ title: 'Floor' })
			floorFolder.addBinding(floorUniforms.uGridLineWidth, 'value', {
				label: 'Grid line (px)',
				min: 0,
				max: 4,
				step: 0.25,
			})
			floorFolder.addBinding(floorUniforms.uFineGridOpacity, 'value', {
				label: 'Fine grid opacity',
				min: 0,
				max: 1,
				step: 0.01,
			})
			floorFolder.addBinding(floorUniforms.uFineGridFade, 'value', {
				label: 'Fine grid fade (x + z)',
				x: { min: -4, max: 4, step: 0.05 },
				y: { min: -4, max: 4, step: 0.05 },
			})
			floorFolder.addBinding(edgeSoftness, 'value', {
				label: 'Dot edge softness',
				min: 0.01,
				max: 1,
				step: 0.01,
			})
			const colorsFolder = gui.addFolder({ title: 'Colors', expanded: false })
			const addColor = (label, uniform) => {
				const state = { color: `#${uniform.value.getHexString()}` }
				colorsFolder
					.addBinding(state, 'color', { label })
					.on('change', ({ value }) => uniform.value.set(value))
			}
			addColor('Floor', floorUniforms.uFloorColor)
			addColor('Grid line', floorUniforms.uGridLineColor)
			addColor('Inbound line', floorUniforms.uInboundLineColor)
			addColor('Inbound dot', inboundDotUniforms.uColor)
			addColor('Outbound line', floorUniforms.uOutboundLineColor)
			addColor('Outbound halo', floorUniforms.uOutboundHaloColor)
			addColor('Outbound dot', outboundDotUniforms.uColor)
			addColor('Destination cell', floorUniforms.uCellIdleColor)
			addColor('Lit cell', floorUniforms.uCellLitColor)
			return {
				update(frame) {
					// Only the nearest hit counts: the cube occludes the floor behind it.
					const hit = pointer.inside
						? pointer.raycaster.intersectObjects([cube.mesh, network.floor], false)[0]
						: undefined
					const onCubeGrid = hit?.object === cube.mesh && hit.face && hit.face.normal.z > 0.5
					cube.update(frame, onCubeGrid && hit.uv ? hit.uv : null)
					network.update(frame, hit)
				},
				resize(nextSize) {
					viewport.value.set(nextSize.width, nextSize.height)
					pickNetwork()
				},
				dispose: cube.dispose,
			}
		},
	})
}
/** Grid hero with the default look from `getProduct('grid')`. */
export const gridHeroScene = createGridHeroScene()
