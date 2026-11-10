import { SRGBColorSpace, VideoTexture } from 'three'
/**
 * Settles when `video` has a frame WebGL can upload, or the source errors.
 * `loadeddata` fires before a frame is decoded, so the picture would pop in late.
 */
function whenPresented(video, texture, mark) {
	return new Promise((resolve) => {
		let settled = false
		const finish = () => {
			if (settled) return
			settled = true
			mark()
			texture.needsUpdate = true
			resolve()
		}
		video.addEventListener('error', finish, { once: true })
		if (typeof video.requestVideoFrameCallback === 'function') {
			video.requestVideoFrameCallback(() => finish())
		} else {
			video.addEventListener('loadeddata', finish, { once: true })
		}
	})
}
/** Muted, looping, autoplaying video wrapped in a texture. */
export function createVideoTexture(src) {
	// CORS has to be requested before `src` is set, or WebGL can't upload frames from
	// another origin (the CMS asset CDN)
	const video = Object.assign(document.createElement('video'), {
		crossOrigin: 'anonymous',
		src,
		autoplay: true,
		loop: true,
		muted: true,
		playsInline: true,
		preload: 'auto',
	})
	const texture = new VideoTexture(video)
	texture.colorSpace = SRGBColorSpace
	let presented = false
	const loaded = whenPresented(video, texture, () => {
		presented = true
	})
	const play = () => {
		void video.play().catch(() => {})
	}
	play()
	return {
		texture,
		/** Settles once a frame can be shown, or the source fails to load. The texture is empty until then. */
		loaded,
		get presented() {
			return presented
		},
		play,
		pause() {
			video.pause()
		},
		/** Plays another source in the same texture (no-op if already playing it). */
		setSource(nextSrc) {
			if (video.getAttribute('src') === nextSrc) return loaded
			presented = false
			video.src = nextSrc
			const next = whenPresented(video, texture, () => {
				presented = true
			})
			play()
			return next
		},
		dispose() {
			video.pause()
			video.removeAttribute('src')
			video.load()
			texture.dispose()
		},
	}
}
