import MessageGroup from "@/features/chat/components/message-group";
import { ChatContext } from "@/features/chat/context/chat-context";
import { SplitTestContext } from "@/shared/context/split-test-context";
import { Fragment, type ContextType } from "react";
import { useTranslation } from "react-i18next";

import type { DiscussionTurn } from "../../../shared/contract-types";
import type { User, UserId } from "../../../../../types/user";

type ChatContextValue = NonNullable<ContextType<typeof ChatContext>>;

function noop() {}

/**
 * MessageGroup reaches MessageContent, which reads the chat context. An AI
 * reviewer discussion is private to one user and is not project chat, so the
 * panel supplies an inert value instead of mounting ChatProvider: no chat
 * history is fetched and no collaborator messages are subscribed to.
 */
const inertChatContext: ChatContextValue = {
  status: "idle",
  messages: [],
  initialMessagesLoaded: true,
  atEnd: true,
  unreadMessageCount: 0,
  idOfMessageBeingEdited: null,
  loadInitialMessages: noop,
  loadMoreMessages: noop,
  sendMessage: noop,
  markMessagesAsRead: noop,
  deleteMessage: noop,
  startedEditingMessage: noop,
  cancelMessageEdit: noop,
  editMessage: noop,
  reset: noop,
  error: null,
};

/**
 * Editing and deleting belong to project chat, where a message is sent to
 * other people. A reviewer turn is a transcript, so the flag stays off.
 */
const inertSplitTestContext = {
  splitTestVariants: {},
  splitTestInfo: {},
};

/**
 * A tool line is placed by the number of turns that existed when the agent
 * called it, so reading and speaking stay in the order they happened.
 */
export type AiReviewerToolLine = {
  position: number;
  label: string;
};

export function AiReviewerDiscussionMessages({
  turns,
  toolLines = [],
}: {
  turns: DiscussionTurn[];
  toolLines?: readonly AiReviewerToolLine[];
}) {
  const { t } = useTranslation();
  // MessageGroup only shows the author of the other party, so this identity is
  // never used for the reader's own turns.
  const author: User = {
    id: "ai-reviewer" as UserId,
    email: "ai-reviewer",
    first_name: t("ai_reviewer_title"),
  };
  const linesAt = (position: number) =>
    toolLines
      .filter((line) => line.position === position)
      .map((line, index) => (
        <code
          key={`tool:${position}:${index}`}
          className="ai-reviewer-tool-line"
          title={line.label}
        >
          {line.label}
        </code>
      ));

  return (
    <SplitTestContext.Provider value={inertSplitTestContext}>
      <ChatContext.Provider value={inertChatContext}>
        {linesAt(0)}
        {turns.map((turn, index) => (
          <Fragment key={`${turn.role}:${index}`}>
            <MessageGroup
              fromSelf={turn.role === "user"}
              user={turn.role === "user" ? undefined : author}
              messages={[
                {
                  id: `${index}`,
                  timestamp: index,
                  content: turn.text,
                },
              ]}
            />
            {linesAt(index + 1)}
          </Fragment>
        ))}
      </ChatContext.Provider>
    </SplitTestContext.Provider>
  );
}
