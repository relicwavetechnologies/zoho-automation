import MessageBubble from "@/components/chat/MessageBubble";
import type { Message } from "@/types";

interface StreamingMessageProps {
  message: Message;
}

export default function StreamingMessage({ message }: StreamingMessageProps) {
  return <MessageBubble message={message} isStreaming />;
}
