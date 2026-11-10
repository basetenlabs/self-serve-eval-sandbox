export function createStore(initialState) {
	let state = initialState
	const listeners = new Set()
	return {
		get: () => state,
		set(patch) {
			state = { ...state, ...patch }
			listeners.forEach((listener) => listener())
		},
		subscribe(listener) {
			listeners.add(listener)
			return () => {
				listeners.delete(listener)
			}
		},
	}
}
