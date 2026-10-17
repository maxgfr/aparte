import { initSecurity } from './security/init.ts'

// Security comes first: the Trusted Types policies, the refusal to run framed or opened by another page and Zod's
// jitless mode are in place before any other module is evaluated, so nothing else is imported statically here.
if (initSecurity()) {
  const [{ createRoot }, { StrictMode, createElement }, { App }, { registerServiceWorker }] = await Promise.all([
    import('react-dom/client'),
    import('react'),
    import('./App.tsx'),
    import('./pwa/register.ts'),
  ])
  const root = document.getElementById('root')
  if (root) createRoot(root).render(createElement(StrictMode, null, createElement(App)))
  registerServiceWorker()
}
