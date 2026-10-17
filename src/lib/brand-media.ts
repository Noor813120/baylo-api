/**
 * The two stills the emails and the emailed-link landing pages use.
 *
 * Both are frames of the band video on the app's Welcome screen (baylo-mobile
 * `src/media/video-sources.ts`, Cloudinary public id `2_xopfjw`), cut by
 * Cloudinary's own transformations — so there is no extra asset to upload or
 * keep in sync, and both stay the same footage the app plays. Public delivery
 * URLs, not credentials.
 */

const VIDEO = "https://res.cloudinary.com/dm7ctbxq7/video/upload"
const SOURCE = "v1788278527/2_xopfjw.jpg"

/**
 * The landing pages' photo band: the full frame at 4 s, portrait, sized for a
 * phone at 2x. The pages lay their own flat tint over it.
 */
export const PAGE_PHOTO_URL = `${VIDEO}/so_4,w_900,c_limit,q_auto,f_jpg/${SOURCE}`

/**
 * The email banner, 960 x 320 (3:1): the frame at 4.5 s from both faces down
 * to the handshake, centred and padded out to 3:1 with forest green — the same
 * green the banner cell falls back to when images are blocked. A 3:1 strip CUT
 * from this portrait frame cannot hold the faces and the clasp at once (it
 * showed an arm and a plant), hence the pad. The slice starts 6% down and runs
 * 62% of the frame so the clasp sits above the sheet's rounded lip, which
 * covers the banner's bottom 24 px. The flat dark tint is BAKED IN
 * (`e_colorize:40` toward ink) because email clients drop the overlay
 * techniques the pages use.
 */
export const EMAIL_BANNER_URL =
  `${VIDEO}/so_4.5/c_crop,g_north,x_0,y_0.06,w_1.0,h_0.62/co_rgb:14140F,e_colorize:40` +
  `/c_pad,w_960,h_320,b_rgb:1B4D2B/q_auto:good,f_jpg/${SOURCE}`
