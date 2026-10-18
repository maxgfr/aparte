/** Tools: the tool set of a chat, tool calls and their results, approvals, web search and sources. */
export const tools = {
  // The tool set of a chat
  button: 'Tools',
  buttonOn: 'Tools: {count} on',
  sheetTitle: 'Tools',
  sheetIntro:
    'Tools let the model look things up or compute while it answers. A tool that reads your other chats or reaches the internet asks you before every use, unless you allow it.',
  frozenHint:
    'The tools of a chat are set by its first message, so the model keeps reading the same conversation. Start a new chat to change them.',
  webSearch: 'Web search',
  webSearchHint: 'The provider searches the web itself and cites its sources. Its searches may be billed.',
  webSearchUnavailable: 'This model has no web search of its own.',
  noToolsModel: 'This model does not take tools: they stay off for it.',
  modelTools: 'Let this model use tools',
  modelToolsHint:
    'The catalog does not say this model takes tools. Turn this on if it does: most recent hosted and local models do.',
  drifted: '{name} changed since this chat started, so it is not offered here.',
  missing: '{name} is no longer available.',
  approvalsTitle: 'Always allowed',
  approvalsEmpty: 'No tool is always allowed.',
  approvalsHint: 'Allowed tools run without asking. A tool whose definition changes asks again.',
  revoke: 'Revoke',
  revokeLabel: 'Revoke {name}',

  // Built-in tools
  name_current_time: 'Current time',
  name_calculator: 'Calculator',
  name_search_conversations: 'Search your chats',
  name_fetch_url: 'Read a web page',
  hint_current_time: 'The date and time on this device. Runs without asking.',
  hint_calculator: 'Exact arithmetic. Runs without asking.',
  hint_search_conversations: 'Finds excerpts of your other chats. Asks first: they are sent to the provider.',
  hint_fetch_url: 'Downloads one public page over HTTPS. Asks first: it reaches the internet.',

  // Tool calls and results
  callLabel: 'Tool call: {name}',
  origin: 'from {origin}',
  statusApproval: 'Waiting for your approval',
  statusRunning: 'Running…',
  statusDone: 'Done',
  statusFailed: 'Failed',
  statusDenied: 'Declined',
  statusRefused: 'Not available in this chat',
  statusSkipped: 'Not run',
  statusPending: 'No result yet',
  arguments: 'Arguments',
  argumentsAndResult: 'Arguments and result',
  result: 'Result',
  argumentsEmpty: 'No arguments.',
  readsOnly: 'Reads only',
  changesThings: 'Can change things',
  destructive: 'Can delete or overwrite',
  openWorld: 'Reaches the internet',
  closedWorld: 'Stays on this device',
  notRunDenied: 'You declined it.',
  notRunStopped: 'The answer was stopped before it ran.',
  notRunBudget: 'The answer reached its limit of steps.',
  notRunUndeclared: 'This chat has no tool of that name.',
  notRunDrifted: 'The tool changed since this chat started.',
  notRunMissing: 'The tool is no longer available.',
  notRunInterrupted: 'Aparté closed before it ran.',

  // Approval
  approveTitle: 'Allow {name}?',
  approveBody:
    'The model wants to run this tool with the arguments below. They come from the model and may come from text it read: check them before you allow it.',
  remember: 'Remember my choice',
  rememberOnce: 'This time only',
  rememberConversation: 'For this chat',
  rememberAlways: 'Always, until this tool changes',
  approve: 'Allow',
  deny: 'Decline',
  approvalPending: 'A tool waits for your approval.',
  runningTools: 'Running tools…',

  // Web search and sources
  searching: 'Searching the web…',
  searched: 'Searched the web for “{query}”',
  searchedNoQuery: 'Searched the web',
  sources: 'Sources',
  sourceUntitled: 'Untitled page',
} as const
