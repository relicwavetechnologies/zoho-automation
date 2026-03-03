import { ThinkingIndicator } from "@/components/chat/ThinkingIndicator";
import { ToolExecutionCard } from "@/components/chat/ToolExecutionCard";
import type { ToolExecution } from "@/types";

interface AgentProgressProps {
  isThinking: boolean;
  toolExecutions: ToolExecution[];
  isStreaming: boolean;
}

export function AgentProgress({
  isThinking,
  toolExecutions,
  isStreaming,
}: AgentProgressProps) {
  return (
    <div className="flex flex-col gap-2">
      {isThinking && toolExecutions.length === 0 && !isStreaming ? <ThinkingIndicator /> : null}

      {toolExecutions.map((tool) => (
        <ToolExecutionCard
          key={tool.id}
          toolName={tool.name}
          args={tool.arguments}
          result={tool.result}
          state={tool.status === "completed" ? "result" : "call"}
        />
      ))}

      {isThinking && toolExecutions.length > 0 && !isStreaming ? <ThinkingIndicator /> : null}
    </div>
  );
}
