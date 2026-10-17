import { combinePresetAndAppleSplashScreens, defineConfig, minimal2023Preset } from '@vite-pwa/assets-generator/config'

/** The logo's own square colour (`--accent`, light). Maskable and Apple icons are padded with it, so the platform's
 * mask cuts into an even field of green instead of exposing the logo's rounded corners on white. */
const mark = '#1d6b5a'

// Icons, maskable icons and iOS splash screens, generated from the logo at build time. Splash screens use the two
// grounds (`--bg` light and dark) so the launch frame matches the first painted screen in either theme.
export default defineConfig({
  headLinkOptions: { preset: '2023' },
  preset: combinePresetAndAppleSplashScreens(
    {
      ...minimal2023Preset,
      // The bubble spans 56% of the logo; 0.1 padding keeps it inside the maskable safe zone (the central 80% circle).
      maskable: { ...minimal2023Preset.maskable, padding: 0.1, resizeOptions: { background: mark, fit: 'contain' } },
      apple: { ...minimal2023Preset.apple, padding: 0.1, resizeOptions: { background: mark, fit: 'contain' } },
    },
    {
      padding: 0.35,
      resizeOptions: { background: '#f6f4ef', fit: 'contain' },
      darkResizeOptions: { background: '#121110', fit: 'contain' },
      linkMediaOptions: { log: true, addMediaScreen: true, xhtml: false },
    },
  ),
  images: ['public/logo.svg'],
})
