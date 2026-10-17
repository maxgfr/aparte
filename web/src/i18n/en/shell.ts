/** The frame around every screen: navigation, the preview notice and update prompts. */
export const shell = {
  skipToContent: 'Skip to content',
  navMain: 'Main',
  navHome: 'Home',
  navAbout: 'About',
  previewLabel: 'Preview notice',
  preview: 'Preview: the storage format is not frozen yet.',
  updateReady: 'A new version of Aparté is ready.',
  updateApply: 'Update',
  updateWaiting: 'Updating once the current reply finishes…',
  offlineReady: 'Aparté now works offline.',
  welcomeTitle: 'Private AI chat, on your device',
  welcomeLead:
    'Aparté is a chat with the AI models you choose, running entirely in this browser: conversations are encrypted on this device and synced end to end, with no server of ours in between.',
  welcomePreview: 'This is an early preview: the app shell is here, the chat comes next.',
  welcomeCreateVault: 'Create your encrypted vault',
  welcomeComingNext: 'Coming next',
  welcomeLearnMore: 'About this build',
  notFoundTitle: 'Nothing here',
  notFoundBody: 'This address does not match any screen of Aparté.',
  notFoundHome: 'Go to the start',
} as const
