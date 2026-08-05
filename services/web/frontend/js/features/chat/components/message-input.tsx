import { useTranslation } from 'react-i18next'

type MessageInputProps = {
  resetUnreadMessages: () => void
  sendMessage: (message: string) => void
  // The AI reviewer reuses this input to talk to a model rather than to
  // collaborators, and can be mounted beside the chat pane, so both the
  // wording and the element id have to be overridable.
  placeholder?: string
  inputId?: string
}

function MessageInput({
  resetUnreadMessages,
  sendMessage,
  placeholder,
  inputId = 'chat-input',
}: MessageInputProps) {
  const { t } = useTranslation()

  function handleKeyDown(event: React.KeyboardEvent) {
    const selectingCharacter = event.nativeEvent.isComposing
    if (event.key === 'Enter' && !selectingCharacter) {
      event.preventDefault()
      const target = event.target as HTMLInputElement
      sendMessage(target.value)
      // wrap the form reset in setTimeout so input sources have time to finish
      // https://github.com/overleaf/internal/pull/9206
      window.setTimeout(() => {
        target.blur()
        target.closest('form')?.reset()
        target.focus()
      }, 0)
    }
  }

  const label = placeholder ?? `${t('your_message_to_collaborators')}…`

  return (
    <form className="new-message">
      <label htmlFor={inputId} className="visually-hidden">
        {label}
      </label>
      <textarea
        id={inputId}
        placeholder={label}
        onKeyDown={handleKeyDown}
        onClick={resetUnreadMessages}
      />
    </form>
  )
}

export default MessageInput
