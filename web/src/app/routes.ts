/** Every screen's path inside the hash. Links and the router read them from here, never as literals. */
export const paths = {
  welcome: '/',
  about: '/about',
  createVault: '/vault/new',
  recover: '/recover',
} as const

export type RouteName = keyof typeof paths
