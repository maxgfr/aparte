/** The sandboxes: the code-running tools, their outputs, and artifacts (live previews of HTML, SVG and diagrams). */
export const sandbox = {
  // The tools
  name_run_js: 'Run JavaScript',
  name_run_python: 'Run Python',
  hint_run_js:
    'Runs code the model writes in a sandbox on this device, with no network and no access to your chats. Asks first.',
  hint_run_python:
    'Runs Python, with numpy, pandas and matplotlib, in a sandbox on this device, with no network and no access to your chats. Asks first.',
  iosMemory:
    'Python with large packages such as pandas or matplotlib can run out of memory on iPhone and iPad. The run then stops.',

  // Outputs of a run
  outputs: 'Files from this run',
  figure: 'Figure {index}',
  imageOutput: 'Image from this run',
  download: 'Download',
  downloadLabel: 'Download {name}',
  fileMissing: 'This file is not on this device.',

  // Artifacts
  artifactLabel: 'Artifact: {title}',
  kind_html: 'HTML page',
  kind_svg: 'SVG image',
  kind_mermaid: 'Diagram',
  view: 'View',
  preview: 'Preview',
  code: 'Code',
  run: 'Run',
  scriptsHint:
    'This artifact contains scripts. They run only if you choose Run, in a sandbox with no network and no access to your chats.',
  scriptsOn: 'Scripts are running in the sandbox.',
  loading: 'Loading the preview…',
  failed: 'The preview could not be shown: {message}',
  unavailable: 'The diagram renderer could not be loaded on this device.',
  frameTitle: 'Preview of {title}',
} as const
