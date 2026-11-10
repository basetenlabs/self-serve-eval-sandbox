import { OrthographicCamera, PerspectiveCamera } from 'three'
export function createCamera(config) {
	const near = config.near ?? 0.1
	const far = config.far ?? 100
	const camera =
		config.type === 'perspective'
			? new PerspectiveCamera(config.fov, 1, near, far)
			: new OrthographicCamera(-1, 1, 1, -1, near, far)
	camera.zoom = config.zoom ?? 1
	camera.position.set(...(config.position ?? [0, 0, 5]))
	if (config.target) {
		camera.lookAt(...config.target)
	}
	camera.updateMatrixWorld()
	return camera
}
export function updateCameraAspect(camera, config, aspect) {
	if (camera instanceof PerspectiveCamera) {
		camera.aspect = aspect
	} else if (config.type === 'orthographic') {
		const halfHeight = config.frustumHeight / 2
		camera.left = -halfHeight * aspect
		camera.right = halfHeight * aspect
		camera.top = halfHeight
		camera.bottom = -halfHeight
	}
	camera.updateProjectionMatrix()
}
