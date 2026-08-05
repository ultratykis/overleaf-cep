import { fireEvent, screen } from "@testing-library/react";

// The host chat input is used unchanged, so its own label identifies it.
export const hostChatInputLabel = "Ask about your manuscript…";

export function typeConversationMessage(text: string) {
  fireEvent.keyDown(screen.getByRole("textbox", { name: hostChatInputLabel }), {
    key: "Enter",
    target: { value: text },
  });
}
