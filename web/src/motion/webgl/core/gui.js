/**
 * Stand-ins for the Tweakpane debug panel the site's scenes bind their parameters to, so scene
 * code stays the site's own.
 *
 * - `createNullGui()` accepts every call and does nothing: the scene runs on the site's values.
 * - `createTuningGui(values)` sets a scene's parameters without a panel:
 *   `mountScene(el, scene, { tune: { 'Cube swaps/Density': 0.05 } })`.
 * - To tune a scene live, pass the real class: `mountScene(el, scene, { Pane })` with
 *   `import { Pane } from 'tweakpane'` (v4). Its folder titles and labels are the keys `tune` takes.
 */
export function createNullGui() {
	return createTuningGui({})
}

/**
 * A panel that never shows: each parameter the scene binds is set from `values` as it is bound,
 * and the scene's own change handler runs, exactly as if the value had been dragged in Tweakpane.
 *
 * @param {Record<string, number | boolean | string | object>} values
 *   Keys are `Folder/Label` as the scene names them (`'Cube swaps/Density'`), or the label alone
 *   when it is unique in the scene. An object value is merged into the bound object (`{ x, y }`).
 * @returns The panel, with `unused`: the keys no binding took (a misspelt name).
 */
export function createTuningGui(values = {}) {
	const pending = new Set(Object.keys(values))
	/** Change handlers of the values that were set, run once the scene is built (`flush`). */
	const changed = []
	const panelHandlers = []
	const node = (path) => {
		const panel = {
			addBinding(target, key, options = {}) {
				const label = options.label ?? key
				const name = [...path, label].join('/')
				const handlers = []
				const binding = {
					on(event, handler) {
						if (event === 'change') handlers.push(handler)
						return binding
					},
					refresh() {},
					dispose() {},
				}
				const match = name in values ? name : label in values ? label : undefined
				if (match !== undefined) {
					pending.delete(match)
					const value = values[match]
					if (value && typeof value === 'object' && target[key] && typeof target[key] === 'object')
						Object.assign(target[key], value)
					else target[key] = value
					// Scenes attach `.on('change')` right after binding, and it may use what they build later
					changed.push(() => handlers.forEach((handler) => handler({ value: target[key] })))
				}
				return binding
			},
			addFolder: ({ title } = {}) => node(title ? [...path, title] : path),
			addButton: () => ({ on: () => panel }),
			addBlade: () => panel,
			on(event, handler) {
				if (event === 'change') panelHandlers.push(handler)
				return panel
			},
			/** Runs the change handlers of every value that was set. The runtime calls it after `create`. */
			flush() {
				const count = changed.length
				changed.splice(0).forEach((run) => run())
				if (count) panelHandlers.forEach((handler) => handler({}))
			},
			refresh() {},
			dispose() {},
			hidden: true,
			// Scenes may park helper nodes (a file input) in the panel's element
			element: document.createElement('div'),
			get unused() {
				return [...pending]
			},
		}
		return panel
	}
	return node([])
}
