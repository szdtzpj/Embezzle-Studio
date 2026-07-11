import type { ChatMessage } from '../domain/types';

const defaultMaxMessages = 48;
const defaultMaxCharacters = 50_000;
const minimumCharacterBudget = 16_000;
const maximumCharacterBudget = 200_000;

function isUsableMessage(message: ChatMessage): boolean {
  return (
    message.id !== 'welcome' &&
    message.status === 'ready' &&
    (Boolean(message.content.trim()) || Boolean(message.attachments?.length))
  );
}

function comparisonContextSelection(messages: ChatMessage[]): Set<string> {
  const selectedByGroup = new Map<string, string>();
  for (const message of messages) {
    if (
      message.role === 'assistant' &&
      message.comparisonGroupId &&
      message.selectedForContext === true &&
      message.status === 'ready' &&
      !selectedByGroup.has(message.comparisonGroupId)
    ) {
      selectedByGroup.set(message.comparisonGroupId, message.id);
    }
  }
  return new Set(selectedByGroup.values());
}

function messageCharacterCost(message: ChatMessage): number {
  const attachmentCost = (message.attachments ?? []).reduce((total, attachment) => {
    const bytes = attachment.size ?? (attachment.base64 ? Math.ceil(attachment.base64.length * 0.75) : 750);
    return total + Math.ceil(bytes * 4 / 3);
  }, 0);
  return message.content.length + (message.reasoningContent?.length ?? 0) + attachmentCost;
}

function contextCharacterBudget(contextWindow?: number): number {
  if (!contextWindow || !Number.isFinite(contextWindow) || contextWindow <= 0) {
    return defaultMaxCharacters;
  }

  // Tokenization depends on the model and language. A conservative character
  // budget leaves room for the response and request framing without pretending
  // to be an exact tokenizer.
  return Math.max(
    minimumCharacterBudget,
    Math.min(maximumCharacterBudget, Math.floor(contextWindow * 2.4))
  );
}

/**
 * Builds a bounded, causally valid transcript for a chat request.
 *
 * System messages are retained first. Conversation history is grouped into
 * user-led turns so trimming never starts with an orphan assistant response.
 * Pending, failed, and cancelled messages are excluded from later requests.
 */
export function buildChatTranscript(
  messages: ChatMessage[],
  contextWindow?: number,
  maxMessages = defaultMaxMessages
): ChatMessage[] {
  const selectedComparisonMessages = comparisonContextSelection(messages);
  const usable = messages.filter(
    (message) =>
      isUsableMessage(message) &&
      (
        message.role !== 'assistant' ||
        !message.comparisonGroupId ||
        selectedComparisonMessages.has(message.id)
      )
  );
  const systemMessages = usable.filter((message) => message.role === 'system');
  const conversational = usable.filter((message) => message.role !== 'system');
  const turns: ChatMessage[][] = [];

  for (const message of conversational) {
    if (message.role === 'user') {
      turns.push([message]);
      continue;
    }

    const currentTurn = turns.at(-1);
    if (currentTurn) {
      currentTurn.push(message);
    }
  }

  const budget = contextCharacterBudget(contextWindow);
  const selectedTurns: ChatMessage[][] = [];
  let selectedCharacters = systemMessages.reduce(
    (total, message) => total + messageCharacterCost(message),
    0
  );
  let selectedMessages = systemMessages.length;

  for (let index = turns.length - 1; index >= 0; index -= 1) {
    const turn = turns[index];
    const turnCharacters = turn.reduce(
      (total, message) => total + messageCharacterCost(message),
      0
    );
    const exceedsBudget = selectedCharacters + turnCharacters > budget;
    const exceedsCount = selectedMessages + turn.length > Math.max(1, maxMessages);

    // Always keep the newest usable turn so the current user message cannot be
    // dropped simply because it is long.
    if (selectedTurns.length > 0 && (exceedsBudget || exceedsCount)) {
      break;
    }

    selectedTurns.unshift(turn);
    selectedCharacters += turnCharacters;
    selectedMessages += turn.length;
  }

  return [...systemMessages, ...selectedTurns.flat()];
}
