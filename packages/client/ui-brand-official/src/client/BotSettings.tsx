/** Bot settings section: embeds the desktop shell's local Bot configuration panel. */
export function BotSettingsSection() {
  return (
    <iframe
      title="Bot settings"
      src="http://127.0.0.1:59100/bot/settings"
      style={{ width: '100%', height: '100%', minHeight: 520, border: 0, display: 'block' }}
    />
  )
}
