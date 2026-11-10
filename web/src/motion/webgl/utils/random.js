/** In-place Fisher–Yates shuffle. */
export function shuffle(items) {
	for (let index = items.length - 1; index > 0; index -= 1) {
		const other = Math.floor(Math.random() * (index + 1))
		;[items[index], items[other]] = [items[other], items[index]]
	}
	return items
}
