/**
 * Elements built without parsing HTML. Text always goes in as text, so a value read from the page
 * or from data can never become markup.
 *
 *   h('button', { type: 'button', class: 'title', 'aria-expanded': 'false' }, 'Deploy', h('i'))
 *
 * `attributes`: `class`, `style` (string), `hidden` and other booleans, any attribute by name.
 * `children`: nodes or strings; null, undefined and false are skipped.
 */
export function h(tag, attributes = {}, ...children) {
	const element = document.createElement(tag)
	for (const [name, value] of Object.entries(attributes)) {
		if (value === false || value == null) continue
		if (name === 'class') element.className = value
		else if (name === 'style') element.style.cssText = value
		else element.setAttribute(name, value === true ? '' : String(value))
	}
	element.append(...children.flat().filter((child) => child != null && child !== false))
	return element
}

/** An SVG element from a constant markup string (it must carry `xmlns`). Never pass page or user text. */
export function svg(markup) {
	const parsed = new DOMParser().parseFromString(markup, 'image/svg+xml').documentElement
	return document.importNode(parsed, true)
}
