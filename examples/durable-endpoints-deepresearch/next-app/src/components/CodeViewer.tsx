"use client";

import { useRef, useEffect } from "react";
import type { StepStatuses, StepParams } from "@/types";

// Source code to display (showing the research workflow)
const SOURCE_CODE = `// Durable Endpoint: Each step.run() is persisted and can retry on failure
export const researchHandler = wrap(async (req: Request) => {
  const { topic, clarifications, researchId } = parseParams(req);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 1: PLANNING - Generate research strategy with reasoning
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const queries = await step.run("generate-queries", async () => {
    // Returns queries with reasoning: { query, reasoning, angle }
    return await generateSearchQueries(topic, clarifications);
  });

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 2: DEEP RESEARCH - Recursive search & analysis
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  await deepResearch(researchId, topic, queries, depth, accumulated);

  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  // PHASE 3: SYNTHESIS - Generate report with citations
  // ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
  const report = await step.run("generate-report", async () => {
    return await generateReport(topic, accumulated);
  });

  return Response.json({ report, sources: accumulated.sources });
});

async function deepResearch(id, topic, queries, depth, acc) {
  if (depth === 0) return;

  for (const { query, reasoning } of queries) {
    // ┌─────────────────────────────────────────────────────────┐
    // │ SEARCH STEP - Durable, auto-retries on failure         │
    // │ If Exa API times out, step automatically retries       │
    // └─────────────────────────────────────────────────────────┘
    const sources = await step.run(\`search-\${hash(query)}\`, async () => {
      return await searchExa(query);  // May retry 3x on failure
    });

    // ┌─────────────────────────────────────────────────────────┐
    // │ ANALYSIS STEP - Extract insights with source rationale │
    // │ Connects new findings to existing learnings            │
    // └─────────────────────────────────────────────────────────┘
    const analysis = await step.run(\`analyze-\${hash(query)}\`, async () => {
      return await extractLearnings(topic, query, sources, acc.learnings);
    });

    // Accumulate findings
    acc.sources.push(...sources);
    acc.learnings.push(...analysis.learnings);

    // ┌─────────────────────────────────────────────────────────┐
    // │ RECURSIVE EXPLORATION - Follow promising directions    │
    // └─────────────────────────────────────────────────────────┘
    if (analysis.followUps.length > 0 && depth > 1) {
      await deepResearch(id, topic, analysis.followUps, depth - 1, acc);
    }
  }
}`;

// Line ranges for each step in the source code
const STEP_LINE_RANGES: Record<string, { start: number; end: number }> = {
  "generate-queries": { start: 8, end: 11 },
  "deep-research": { start: 16, end: 16 },
  search: { start: 36, end: 38 },
  learn: { start: 44, end: 46 },
  "generate-report": { start: 21, end: 23 },
};

// TypeScript syntax highlighter
function highlightSyntax(code: string): React.ReactNode[] {
  const tokens: React.ReactNode[] = [];
  let i = 0;
  let key = 0;

  const keywords = new Set([
    "const", "let", "var", "function", "return", "if", "else", "for", "while",
    "async", "await", "new", "export", "import", "from", "true", "false",
    "null", "undefined", "typeof", "instanceof", "class", "extends",
  ]);

  const types = new Set([
    "Request", "Response", "Promise", "step", "Exa", "anthropic",
  ]);

  while (i < code.length) {
    // Comments
    if (code.slice(i, i + 2) === "//") {
      let end = code.indexOf("\n", i);
      if (end === -1) end = code.length;
      tokens.push(
        <span key={key++} className="text-gray-400 italic">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Template literals
    if (code[i] === "`") {
      let end = i + 1;
      while (end < code.length && code[end] !== "`") {
        if (code[end] === "\\") end++;
        end++;
      }
      end++;
      tokens.push(
        <span key={key++} className="text-green-600">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Strings
    if (code[i] === '"' || code[i] === "'") {
      const quote = code[i];
      let end = i + 1;
      while (end < code.length && code[end] !== quote) {
        if (code[end] === "\\") end++;
        end++;
      }
      end++;
      tokens.push(
        <span key={key++} className="text-green-600">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Numbers
    if (/\d/.test(code[i]) && (i === 0 || !/\w/.test(code[i - 1]))) {
      let end = i;
      while (end < code.length && /[\d.]/.test(code[end])) end++;
      tokens.push(
        <span key={key++} className="text-orange-500">
          {code.slice(i, end)}
        </span>
      );
      i = end;
      continue;
    }

    // Words
    if (/[a-zA-Z_$]/.test(code[i])) {
      let end = i;
      while (end < code.length && /[\w$]/.test(code[end])) end++;
      const word = code.slice(i, end);

      if (keywords.has(word)) {
        tokens.push(
          <span key={key++} className="text-purple-600 font-medium">
            {word}
          </span>
        );
      } else if (types.has(word)) {
        tokens.push(
          <span key={key++} className="text-blue-600">
            {word}
          </span>
        );
      } else if (code[end] === "(") {
        tokens.push(
          <span key={key++} className="text-amber-600">
            {word}
          </span>
        );
      } else {
        tokens.push(
          <span key={key++} className="text-gray-800">
            {word}
          </span>
        );
      }
      i = end;
      continue;
    }

    // Operators and punctuation
    if (/[{}()\[\];:,.<>!=+\-*/%&|^~?]/.test(code[i])) {
      tokens.push(
        <span key={key++} className="text-gray-600">
          {code[i]}
        </span>
      );
      i++;
      continue;
    }

    tokens.push(<span key={key++}>{code[i]}</span>);
    i++;
  }

  return tokens;
}

type CodeViewerProps = {
  activeStep: string | null;
  stepStatuses: StepStatuses;
  currentStepParams: StepParams;
};

export function CodeViewer({
  activeStep,
  stepStatuses,
  currentStepParams,
}: CodeViewerProps) {
  const codeRef = useRef<HTMLPreElement>(null);

  // Scroll code viewer to active step
  useEffect(() => {
    if (activeStep && codeRef.current) {
      const range = STEP_LINE_RANGES[activeStep];
      if (range) {
        const lineHeight = 20;
        const scrollTo = (range.start - 3) * lineHeight;
        codeRef.current.scrollTo({ top: scrollTo, behavior: "smooth" });
      }
    }
  }, [activeStep]);

  const getLineStatus = (lineNum: number): "completed" | "running" | null => {
    for (const [stepId, range] of Object.entries(STEP_LINE_RANGES)) {
      if (lineNum >= range.start && lineNum <= range.end) {
        if (stepId === "search" || stepId === "learn") {
          if (activeStep === stepId) return "running";
        } else {
          const status = stepStatuses[stepId];
          if (status === "completed") return "completed";
          if (status === "running") return "running";
        }
      }
    }
    return null;
  };

  const shouldShowParams = (lineNum: number): boolean => {
    if (!currentStepParams) return false;
    if (activeStep === "search" && lineNum === 38) return true;
    if (activeStep === "learn" && lineNum === 46) return true;
    return false;
  };

  const lines = SOURCE_CODE.split("\n");

  return (
    <div className="flex flex-col h-full">
      {/* Code Header */}
      <div className="bg-gray-100 border-b border-gray-200 px-4 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex gap-1.5">
            <div className="w-3 h-3 rounded-full bg-red-400"></div>
            <div className="w-3 h-3 rounded-full bg-yellow-400"></div>
            <div className="w-3 h-3 rounded-full bg-green-400"></div>
          </div>
          <span className="text-gray-600 text-sm font-medium">
            <code>GET /api/research</code>
          </span>
        </div>
        <span className="text-xs text-gray-600 bg-gray-200 px-2 py-1 rounded font-medium">
          Durable Endpoint
        </span>
      </div>

      {/* Code Content */}
      <pre
        ref={codeRef}
        className="flex-1 overflow-auto bg-gray-50 p-4 font-mono text-sm leading-5 text-gray-800"
      >
        <code>
          {lines.map((line, index) => {
            const lineNum = index + 1;
            const lineStatus = getLineStatus(lineNum);

            let className = "flex ";
            let borderClass = "";

            if (lineStatus === "running") {
              className += "bg-blue-50";
              borderClass = "border-l-2 border-blue-500";
            } else if (lineStatus === "completed") {
              className += "bg-green-50";
              borderClass = "border-l-2 border-green-500";
            }

            return (
              <div key={lineNum}>
                <div className={`${className} ${borderClass}`}>
                  <span className="w-10 text-right pr-3 text-gray-400 select-none text-xs">
                    {lineNum}
                  </span>
                  <span className="flex-1 whitespace-pre">
                    {highlightSyntax(line)}
                  </span>
                </div>
                {shouldShowParams(lineNum) && currentStepParams && (
                  <div className="ml-10 pl-4 py-1 bg-blue-100 border-l-2 border-blue-500">
                    <span className="text-xs text-blue-700 font-mono">
                      → query: &quot;{currentStepParams.query?.substring(0, 40)}
                      {(currentStepParams.query?.length || 0) > 40 ? "..." : ""}
                      &quot;
                      {currentStepParams.depth &&
                        ` | depth: ${currentStepParams.depth}`}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </code>
      </pre>
    </div>
  );
}
