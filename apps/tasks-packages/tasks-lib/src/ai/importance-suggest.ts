import Anthropic from "@anthropic-ai/sdk";

export interface ImportanceSuggestInput {
  newTaskTitle: string;
  newTaskDescription: string;
  existingTaskTitles: string[]; // ordered by current importance, highest first
  apiKey: string;
}

/**
 * Ask Claude where a new task should be inserted in the importance ordering.
 * Returns a 0-based insertion index (0 = highest priority).
 */
export async function suggestImportanceIndex(
  input: ImportanceSuggestInput,
): Promise<number> {
  const { newTaskTitle, newTaskDescription, existingTaskTitles, apiKey } = input;

  if (existingTaskTitles.length === 0) return 0;

  const client = new Anthropic({ apiKey });

  const numbered = existingTaskTitles
    .map((title, i) => `${i + 1}. ${title}`)
    .join("\n");

  const prompt = `You are helping prioritize a task list. The current tasks are ordered by importance (1 = highest):

${numbered}

A new task is being added:
Title: ${newTaskTitle}
Description: ${newTaskDescription}

At what position (1-based) should this new task be inserted? Respond with ONLY a single integer.`;

  const response = await client.messages.create({
    model: "claude-haiku-4-5-20251001",
    max_tokens: 10,
    messages: [{ role: "user", content: prompt }],
  });

  const text =
    response.content[0]?.type === "text" ? response.content[0].text.trim() : "0";
  const parsed = parseInt(text, 10);

  if (isNaN(parsed) || parsed < 1) return 0;
  // Convert from 1-based to 0-based, clamped to valid range
  return Math.min(parsed - 1, existingTaskTitles.length);
}
