import MessageGroup from "@/features/chat/components/message-group";
import { ChatContext } from "@/features/chat/context/chat-context";
import { SplitTestContext } from "@/shared/context/split-test-context";
import firstCharacter from "@/shared/utils/first-character";
import {
  getBackgroundColorForUserId,
  hslStringToLuminance,
} from "@/shared/utils/colors";
import { Fragment, type ContextType } from "react";
import { useTranslation } from "react-i18next";

import type { DiscussionTurn } from "../../../shared/contract-types";
import type { User, UserId } from "../../../../../types/user";
import { AiReviewerMarkdown } from "./ai-reviewer-markdown";

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

function AiReviewerAssistantMessage({
  author,
  text,
}: {
  author: User;
  text: string;
}) {
  const backgroundColor = getBackgroundColorForUserId(author.id);
  const avatarStyle = {
    borderColor: backgroundColor,
    backgroundColor,
    color:
      hslStringToLuminance(backgroundColor) < 0.5
        ? "var(--content-primary-dark)"
        : "var(--content-primary)",
  };

  return (
    <div className="chat-message">
      <div className="message-row">
        <div className="message-avatar-placeholder" />
        <div className="message-author">
          <span>{author.first_name || author.email}</span>
        </div>
      </div>
      <div className="message-row">
        <div className="message-avatar">
          <div className="avatar" style={avatarStyle}>
            {firstCharacter(author.first_name || author.email)}
          </div>
        </div>
        <div className="message-container first-row-in-message last-row-in-message">
          <div />
          <div className="message-content">
            <AiReviewerMarkdown
              className="ai-reviewer-panel-prose"
              content={text}
              translate="no"
            />
          </div>
        </div>
      </div>
    </div>
  );
}

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
        {turns.map((turn, index) => {
          return (
            <Fragment key={`${turn.role}:${index}`}>
              {turn.role === "assistant" ? (
                <AiReviewerAssistantMessage author={author} text={turn.text} />
              ) : (
                <MessageGroup
                  fromSelf
                  messages={[
                    {
                      id: `${index}`,
                      timestamp: index,
                      content: turn.text,
                    },
                  ]}
                />
              )}
              {linesAt(index + 1)}
            </Fragment>
          );
        })}
      </ChatContext.Provider>
    </SplitTestContext.Provider>
  );
}
