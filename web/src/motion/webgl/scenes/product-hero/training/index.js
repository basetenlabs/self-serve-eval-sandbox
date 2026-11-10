import { Color } from 'three'
import { pointerOnGridFace } from '../../../objects/productCube.js'
import { getProduct } from '../../../palette.js'
import { createHeroProductCube, defineProductHeroScene } from '../shared.js'
import { createCubeTrail } from './cubeTrail.js'
import { createFloorGrid } from './floorGrid.js'
import { createTrainingFlow } from './flow.js'
/** Training (blue): loss-curve lines and particles converge into the cube and leave as a trail. */
export function createTrainingHeroScene({ product = getProduct('training'), videoUrl } = {}) {
	return defineProductHeroScene({
		name: 'Product Hero · Training',
		create(context) {
			const { scene, pointer, size, gui } = context
			scene.background = new Color('#F4F7F9')
			createCubeTrail(scene, gui.addFolder({ title: 'Cube trail' }), product.color)
			const floorGrid = createFloorGrid(scene, gui.addFolder({ title: 'Floor grid' }))
			const cube = createHeroProductCube(context, { product, gridCellColor: '#D4EBFF', videoUrl })
			const flow = createTrainingFlow(scene, gui, size, product.color)
			return {
				update(frame) {
					floorGrid.update(frame.delta, frame.elapsed)
					flow.update(frame.elapsed)
					cube.update(frame, pointerOnGridFace(pointer, cube.mesh))
				},
				resize: flow.resize,
				dispose: cube.dispose,
			}
		},
	})
}
/** Training hero with the default look from `PRODUCTS`. */
export const trainingHeroScene = createTrainingHeroScene()
