/**
 * Brand colors shared by every scene: the Base step of each product ramp in baseten.css.
 * (The site's code still carries older blue, yellow and purple defaults, #1E96FC, #F4B23F and
 * #9B4BE7; its pages override them from the CMS with the values below.)
 */
export const BRAND_COLORS = {
	green: '#19E76E',
	pink: '#FFA9FD',
	blue: '#3DA6FF',
	yellow: '#FFBE4D',
	purple: '#A159E8',
}
/** Near-black used for holes and dark faces. */
export const DARK_COLOR = '#0E0E0E'
/** Products in display order: the Home Hero and Products scenes index into this list. */
export const PRODUCTS = [
	{
		id: 'dedicated-inference',
		color: BRAND_COLORS.green,
		background: '#D7FACE',
		pattern: '00000 \\ 01110 \\ 01010 \\ 01110 \\ 00000',
	},
	{
		id: 'model-apis',
		color: BRAND_COLORS.pink,
		background: '#F4E7F2',
		pattern: '00000 \\ 00100 \\ 01010 \\ 00100 \\ 00000',
	},
	{
		id: 'training',
		color: BRAND_COLORS.blue,
		background: '#D4EBFF',
		pattern: '00000 \\ 01010 \\ 00100 \\ 01010 \\ 00000',
	},
	{
		// Placeholder: Frontier Gateway has no cube design or hero scene yet.
		id: 'frontier-gateway',
		color: '#CDDCC7',
		background: '#F1F7EF',
		pattern: '00000 \\ 01110 \\ 00000 \\ 01110 \\ 00000',
	},
	{
		id: 'sandbox',
		color: BRAND_COLORS.yellow,
		background: '#FFEDC4',
		pattern: '00000 \\ 01100 \\ 01010 \\ 00110 \\ 00000',
	},
]
/** Products with a Product Hero scene but no place in `PRODUCTS`, whose indices the carousels rely on. */
const UNLISTED_PRODUCTS = [
	{
		id: 'grid',
		color: BRAND_COLORS.purple,
		background: '#D6B7F5',
		pattern: '00000 \\ 01010 \\ 00000 \\ 01010 \\ 00000',
	},
]
export function getProduct(id) {
	return [...PRODUCTS, ...UNLISTED_PRODUCTS].find((product) => product.id === id)
}
const FACE_GRID_SIZE = 5
/**
 * Parses a face pattern as it comes from the CMS: 5 rows of 5 digits, top to
 * bottom, separated by `\` (spaces around it optional; line breaks also
 * accepted). `1` = black cell (hole), `0` = white cell.
 *
 *   00000 \ 01110 \ 00000 \ 01110 \ 00000
 *
 * Returns a 25-bit mask (bit = row * 5 + column, row 0 at the top) for the
 * `uPatternMask` uniforms, read in GLSL by `patternHole`. Throws on malformed
 * input, so CMS data can be validated where it is fetched.
 */
export function parseFacePattern(source) {
	const rows = source
		.split(/\\|\r?\n/)
		.map((row) => row.trim())
		.filter(Boolean)
	const isValid =
		rows.length === FACE_GRID_SIZE &&
		rows.every((row) => row.length === FACE_GRID_SIZE && /^[01]+$/.test(row))
	if (!isValid) {
		throw new Error(
			`Invalid face pattern "${source}": expected ${FACE_GRID_SIZE} rows of ${FACE_GRID_SIZE} digits (0/1) separated by "\\".`,
		)
	}
	return rows
		.join('')
		.split('')
		.reduce((mask, digit, bit) => (digit === '1' ? mask | (1 << bit) : mask), 0)
}
