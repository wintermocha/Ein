// Keep user preferences and profile paths, but never pass a caller's pane or Slack credentials to Herdr.
export function herdrEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(source).filter(([key]) =>
    !/^(?:EIN|HOGU)_(?:APP|BOT)_TOKEN$/.test(key) &&
    !/^HERDR_(?:ENV$|SESSION$|(?:CLIENT_)?SOCKET_PATH$|(?:ACTIVE_)?(?:WORKSPACE|TAB|PANE)_|PLUGIN_|STARTUP_CWD$)/.test(key)
  ));
}
