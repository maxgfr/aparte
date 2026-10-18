# Local models

Aparté can chat with models that run on your own hardware: a server on this computer (Ollama, LM Studio, Jan, or any
OpenAI-compatible server), a model in the browser itself (WebLLM on WebGPU), or Chrome's built-in Gemini Nano. None of
them needs a key, and the conversation stays encrypted in the vault as with any other provider.

## A server on this computer

Add it from the Models screen. The presets point at each server's OpenAI-compatible API:

| Server | Base URL |
|---|---|
| Ollama | `http://localhost:11434/v1` |
| LM Studio | `http://localhost:1234/v1` |
| Jan | `http://localhost:1337/v1` |

Plain `http://` is allowed for `localhost` and `127.0.0.1` only; any other address must be `https://`. The app lists
the models with `GET <base>/models` and chats through the OpenAI chat completions API. **Test connection** tells a
server that is down from one that refuses the app's origin.

### CORS

A page can read a local server's answers only if the server allows the page's origin. For the deployed app the origin
is `https://maxgfr.github.io` (a self-hosted copy uses its own; the help on the screen shows the right one).

- **Ollama:** start it with the origin allowed:

  ```sh
  OLLAMA_ORIGINS=https://maxgfr.github.io ollama serve
  ```

  On macOS with the menu bar app, set the variable for it with
  `launchctl setenv OLLAMA_ORIGINS https://maxgfr.github.io`, then restart Ollama. Several origins are separated by
  commas.
- **LM Studio:** open the server settings, turn on **Enable CORS**, and start the server.
- **Jan:** allow the origin in its API server settings.
- **Another server:** allow the origin in its CORS settings (`Access-Control-Allow-Origin`), for `GET` and `POST`
  with the `Content-Type` and `Authorization` headers.

### Browser permissions and limits

- **Chrome and Edge** ask whether the site may reach devices on your local network. Allow it. The permission is given
  to the whole origin `https://maxgfr.github.io`, so to every site published there, not only to Aparté
  ([docs/security-model.md](security-model.md#shared-origin)); a self-hosted copy on its own origin avoids that.
- **Safari** may refuse calls from a secure page to `http://localhost`. Use Chrome, Edge or Firefox, or serve the model
  over `https`.
- A server elsewhere on your network needs `https` (a reverse proxy with a certificate) and the same CORS rule.
- Tools work when the model and the server support OpenAI-style tool calls.

## In the browser: WebLLM

Models run on the device's GPU through WebGPU (recent Chrome and Edge; Safari and Firefox only on some systems). The
Models screen lists what this device can run: it checks WebGPU, fp16 support, the GPU's limits, a memory budget (half
of `navigator.deviceMemory`, or 2 GB when the browser does not say) and free storage (at least 1 GiB, or the vault's
size, must stay free after the download).

| Model | Download (q4f16) | GPU memory (q4f16 / q4f32) | |
|---|---|---|---|
| SmolLM2 360M | 214 MB | 376 / 580 MB | |
| Qwen3.5 0.8B | 454 MB | 1.6 / 1.9 GB | reasoning |
| Llama 3.2 1B | 711 MB | 0.9 / 1.1 GB | |
| Qwen3.5 2B | 1.09 GB | 2.2 / 2.6 GB | reasoning |
| Gemma 4 2B | 2.84 GB | 3.4 / 3.9 GB | |
| Llama 3.2 3B | 1.82 GB | 2.3 / 3.0 GB | |
| Phi-4-mini 3.8B | 2.19 GB | 3.4 / 4.2 GB | |
| Qwen3.5 4B | 2.40 GB | 3.9 / 4.7 GB | reasoning |
| Hermes 3 8B | 4.53 GB | 4.9 / 5.8 GB | tools |

Each model comes in a q4f16 and a q4f32 build (a GPU without fp16 runs only q4f32). The context window is 4096 tokens.
Only the Hermes builds call tools; models are text only.

**Where the files come from.** The weights are read from Hugging Face at a fixed commit
(`huggingface.co/<repo>/resolve/<commit>/`, which redirects to its CDN), and the compiled model libraries from
`mlc-ai/binary-mlc-llm-libs` at a fixed commit on `raw.githubusercontent.com`. Every file has a SHA-256 pinned in the
app (`web/src/workers/webllm-files.json`): it is checked before it is stored and again the first time it is read in a
session, and a file that does not match is deleted. The download happens once, when you choose **Download**; a chat
never downloads, and with the model on the device a chat never goes online.

**Storage.** The files are kept in CacheStorage (`aparte-webllm/model`, `aparte-webllm/config`, `aparte-webllm/wasm`);
**Delete from this device** removes them. They are public files, so they are not encrypted: which models are on the
device is visible to anyone who can read the browser profile. Locking the vault stops the engines.

## Chrome built-in AI

Chrome 138 and later on desktop, on devices with enough memory and disk, has a Prompt API with Gemini Nano. Chrome
downloads the model once for the browser (about 2 GB) when you ask. It takes about 6,000 tokens of input and 2,000 of
output, text only, without tools, and answers in English, Spanish or Japanese.

## On-device embeddings and dictation

Knowledge bases embed text with `Xenova/all-MiniLM-L6-v2`, and dictation runs Whisper (`onnx-community/whisper-base`)
on the device by default, through transformers.js and an ONNX Runtime served by the app itself. Both are read from
Hugging Face at a pinned commit, checked against pinned digests and cached in `aparte-transformers`.

## The CLI

`aparte --provider ollama` and `aparte --provider lmstudio` use the same local servers, with no CORS setting needed;
`--base-url` points at another one (`https`, or `http` on the loopback). See [docs/cli.md](cli.md).
