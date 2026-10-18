/*
 * Consents the user gave in this page, kept in memory only. localStorage (src/app/prefs.ts) says which engine this
 * device chose, but every page of a shared origin can write it: a choice that sends data to a third party is honoured
 * only once the user accepted its warning here, in this page.
 */

let browserDictation = false

/** The browser's own speech service for dictation, which sends the audio to the browser maker's servers. */
export const browserDictationConsent = {
  given: (): boolean => browserDictation,
  give: (): void => {
    browserDictation = true
  },
}
