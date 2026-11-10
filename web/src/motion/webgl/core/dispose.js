function isTexture(value) {
	return typeof value === 'object' && value !== null && 'isTexture' in value
}
/** Textures referenced by a material, as properties (`map`, ...) or uniform values. */
export function materialTextures(material) {
	const uniforms = 'uniforms' in material ? material.uniforms : {}
	return [
		...Object.values(material),
		...Object.values(uniforms).map((uniform) => uniform.value),
	].filter(isTexture)
}
/** Disposes every geometry, material and material texture reachable from `root`. */
export function disposeObject3D(root) {
	const disposed = new Set()
	const dispose = (resource) => {
		if (!disposed.has(resource)) {
			disposed.add(resource)
			resource.dispose()
		}
	}
	root.traverse((object) => {
		const { geometry, material } = object
		const materials = Array.isArray(material) ? material : material ? [material] : []
		if (geometry) {
			dispose(geometry)
		}
		for (const material of materials) {
			materialTextures(material).forEach(dispose)
			dispose(material)
		}
	})
}
