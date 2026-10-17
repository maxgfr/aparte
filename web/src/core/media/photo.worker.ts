/*
 * Photo preparation off the main thread (core/media/photo.ts). One worker prepares one photo: it receives the file,
 * answers once and is terminated by the caller, so the decoded pixels are released with it.
 */
import { answerPhotoRequest, type PhotoRequest } from './photo.ts'

const scope = globalThis as unknown as DedicatedWorkerGlobalScope

scope.onmessage = async (event: MessageEvent<PhotoRequest>) => {
  const response = await answerPhotoRequest(event.data)
  scope.postMessage(response, response.ok ? [response.bytes.buffer] : [])
}
