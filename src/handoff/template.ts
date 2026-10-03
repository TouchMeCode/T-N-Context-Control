/** The handoff markdown template and its placeholder filler. */

export interface HandoffData {
  timestamp: string;
  source: string;
  messageCount: number;
  tokens: number;
  limit: number;
  percent: number;
  goal: string;
  progress: string;
  decisions: string;
  pendingTasks: string;
  files: string;
  nextPrompt: string;
}

export const HANDOFF_TEMPLATE = `# Project Handoff

**Generated:** {{timestamp}}
**Source:** {{source}}
**Messages:** {{messageCount}}
**Tokens:** {{tokens}} / {{limit}} ({{percent}}%)

## Goal
{{goal}}

## Current Progress
{{progress}}

## Important Decisions
{{decisions}}

## Pending Tasks
{{pendingTasks}}

## Files Referenced
{{files}}

## Recommended Next Prompt
{{nextPrompt}}
`;

/** Replace every {{placeholder}} in the template with values from `data`. */
export function renderHandoff(data: HandoffData): string {
  return HANDOFF_TEMPLATE.replace(/\{\{(\w+)\}\}/g, (_match, key: string) => {
    const value = (data as unknown as Record<string, unknown>)[key];
    return value === undefined || value === null ? "" : String(value);
  });
}
