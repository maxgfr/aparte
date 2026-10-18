import type { BrowserContext, Page, Request } from '@playwright/test'

/*
 * Stand-ins for what a test cannot have on every engine: a microphone (a tone from Web Audio, handed out by
 * getUserMedia), this device's voices (speechSynthesis with a chosen list, recording what it is asked to speak) and
 * notifications (recorded, never shown). Each is installed by an init script, before the app's own code runs.
 */

/** A microphone that hears a 440 Hz tone: getUserMedia returns a Web Audio stream; the calls are counted. */
export async function fakeMicrophone(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices
    if (!devices) return
    const w = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
      __microphoneCalls?: number
    }
    const fake = async () => {
      w.__microphoneCalls = (w.__microphoneCalls ?? 0) + 1
      const Ctor = w.AudioContext ?? w.webkitAudioContext
      if (!Ctor) throw new DOMException('No Web Audio', 'NotFoundError')
      const ctx = new Ctor()
      await ctx.resume().catch(() => undefined)
      const tone = ctx.createOscillator()
      tone.frequency.value = 440
      const gain = ctx.createGain()
      gain.gain.value = 0.5
      const out = ctx.createMediaStreamDestination()
      tone.connect(gain)
      gain.connect(out)
      tone.start()
      return out.stream
    }
    // On the prototype as well as the instance: WebKit ignores an assignment to the instance.
    Object.defineProperty(Object.getPrototypeOf(devices), 'getUserMedia', { value: fake, configurable: true })
    Object.defineProperty(devices, 'getUserMedia', { value: fake, configurable: true })
  })
}

/**
 * A machine whose sound system never starts, as Firefox has on a Linux machine without audio output: every
 * AudioContext stays suspended and resume() never settles. getUserMedia still hands out a stream (a canvas track
 * standing in for the microphone); its tracks are kept in `window.__microphoneTracks` to check they are released.
 */
export async function fakeStalledAudio(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const devices = navigator.mediaDevices
    const w = window as unknown as {
      AudioContext?: typeof AudioContext
      webkitAudioContext?: typeof AudioContext
      __microphoneTracks?: MediaStreamTrack[]
    }
    const tracks: MediaStreamTrack[] = []
    w.__microphoneTracks = tracks
    for (const Ctor of [w.AudioContext, w.webkitAudioContext]) {
      if (!Ctor) continue
      Object.defineProperty(Ctor.prototype, 'state', { get: () => 'suspended', configurable: true })
      Object.defineProperty(Ctor.prototype, 'resume', { value: () => new Promise(() => undefined), configurable: true })
    }
    if (!devices) return
    const fake = async () => {
      const stream = document.createElement('canvas').captureStream()
      tracks.push(...stream.getTracks())
      return stream
    }
    Object.defineProperty(Object.getPrototypeOf(devices), 'getUserMedia', { value: fake, configurable: true })
    Object.defineProperty(devices, 'getUserMedia', { value: fake, configurable: true })
  })
}

export interface FakeVoice {
  readonly name: string
  readonly lang: string
  readonly localService: boolean
}

/**
 * speechSynthesis with exactly `voices`. What the app asks to speak is recorded in `window.__spoken` as
 * `{ text, voice, local }`; an utterance "ends" after 300 ms.
 */
export async function fakeVoices(page: Page, voices: readonly FakeVoice[]): Promise<void> {
  await page.addInitScript((list: readonly FakeVoice[]) => {
    const spoken: { text: string; voice: string | null; local: boolean | null }[] = []
    const w = window as unknown as { __spoken: typeof spoken }
    w.__spoken = spoken
    const made = list.map((v) => ({ ...v, voiceURI: v.name, default: false }))
    class Utterance {
      text: string
      voice: (typeof made)[number] | null = null
      lang = ''
      onend: (() => void) | null = null
      onerror: (() => void) | null = null
      constructor(text: string) {
        this.text = text
      }
    }
    let timer: ReturnType<typeof setTimeout> | null = null
    let current: Utterance | null = null
    const synthesis = {
      getVoices: () => made,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
      speak(u: Utterance) {
        spoken.push({ text: u.text, voice: u.voice?.name ?? null, local: u.voice?.localService ?? null })
        current = u
        timer = setTimeout(() => {
          current = null
          u.onend?.()
        }, 300)
      },
      cancel() {
        if (timer !== null) clearTimeout(timer)
        const u = current
        current = null
        u?.onend?.()
      },
    }
    Object.defineProperty(window, 'speechSynthesis', { value: synthesis, configurable: true })
    Object.defineProperty(window, 'SpeechSynthesisUtterance', { value: Utterance, configurable: true })
  }, voices)
}

/**
 * Notifications that are granted and recorded in `window.__notifications` (title, body, data), and a page that can be
 * made to look hidden with `window.__hidden = true` (what a tab in the background reports).
 */
export async function fakeNotifications(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const shown: { title: string; body: string | undefined; data: unknown }[] = []
    const w = window as unknown as { __notifications: typeof shown; __hidden: boolean }
    w.__notifications = shown
    w.__hidden = false
    class FakeNotification {
      static permission: NotificationPermission = 'default'
      static async requestPermission(): Promise<NotificationPermission> {
        FakeNotification.permission = 'granted'
        return 'granted'
      }
      onclick: (() => void) | null = null
      constructor(title: string, options?: NotificationOptions) {
        shown.push({ title, body: options?.body, data: options?.data })
      }
      close() {}
    }
    Object.defineProperty(window, 'Notification', { value: FakeNotification, configurable: true })
    Object.defineProperty(document, 'visibilityState', { get: () => (w.__hidden ? 'hidden' : 'visible') })
  })
}

/** A valid 8 x 8 PNG of the accent green. */
export const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAgAAAAICAYAAADED76LAAAAEklEQVR4nGOQy476jw8zjAwFANRbeIFtLCBWAAAAAElFTkSuQmCC'

export const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-methods': 'GET, POST',
  'access-control-allow-headers': 'authorization, content-type, accept, x-goog-api-key',
}

/** Routes POSTs to `url` to `answer`, answering preflights, and returns the requests it served. */
export async function servePost(
  context: BrowserContext,
  url: string,
  answer: (request: Request) => { status?: number; contentType: string; body: string | Buffer },
): Promise<Request[]> {
  const seen: Request[] = []
  await context.route(url, async (route) => {
    const request = route.request()
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS })
      return
    }
    seen.push(request)
    const a = answer(request)
    await route.fulfill({ status: a.status ?? 200, headers: { ...CORS, 'content-type': a.contentType }, body: a.body })
  })
  return seen
}
