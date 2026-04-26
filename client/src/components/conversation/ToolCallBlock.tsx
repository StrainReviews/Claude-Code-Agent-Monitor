import { useState } from "react";
import { ChevronDown, ChevronRight, Wrench, AlertCircle } from "lucide-react";
import type { TranscriptContent } from "../../lib/types";

interface ToolCallBlockProps {
  toolUse: TranscriptContent;
  toolResult?: TranscriptContent | null;
}

export function ToolCallBlock({ toolUse, toolResult }: ToolCallBlockProps) {
  const [expanded, setExpanded] = useState(false);

  const isError = toolResult?.is_error;
  const hasResult = toolResult != null;

  return (
    <div
      className={`rounded-lg border text-sm ${
        isError
          ? "border-red-500/30 bg-red-500/5"
          : "border-surface-3 bg-surface-2"
      }`}
    >
      {/* Header — always visible */}
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-surface-3/50 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        ) : (
          <ChevronRight className="w-3.5 h-3.5 text-gray-500 flex-shrink-0" />
        )}
        <Wrench className={`w-3.5 h-3.5 flex-shrink-0 ${isError ? "text-red-400" : "text-violet-400"}`} />
        <span className="font-mono text-violet-300 font-medium">{toolUse.name}</span>
        {isError && <AlertCircle className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />}
        <span className="text-gray-600 text-xs ml-auto">tool_use</span>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="border-t border-surface-3 px-3 py-2 space-y-2">
          {/* Tool input */}
          {toolUse.input && (
            <div>
              <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">Input</p>
              <pre className="text-xs text-gray-300 bg-surface-4 rounded p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all">
                {typeof toolUse.input === "object" && "_truncated" in toolUse.input
                  ? String((toolUse.input as { _truncated: string })._truncated)
                  : JSON.stringify(toolUse.input, null, 2)}
              </pre>
            </div>
          )}

          {/* Tool result */}
          {hasResult && (
            <div>
              <p className="text-[11px] text-gray-500 uppercase tracking-wider mb-1">
                {isError ? "Error" : "Output"}
              </p>
              <pre
                className={`text-xs rounded p-2 overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap break-all ${
                  isError
                    ? "text-red-300 bg-red-500/10"
                    : "text-gray-300 bg-surface-4"
                }`}
              >
                {toolResult.output || "(empty)"}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}