import type { GenerationQueue, GenerationRequest } from "./types.js";

export function createGenerationQueue(): GenerationQueue {
  const items: GenerationRequest[] = [];

  function insertSorted(request: GenerationRequest): void {
    const priority = request.priority ?? 0;
    let insertIndex = items.length;
    for (let index = 0; index < items.length; index++) {
      if ((items[index].priority ?? 0) < priority) {
        insertIndex = index;
        break;
      }
    }
    items.splice(insertIndex, 0, request);
  }

  return {
    enqueue(request: GenerationRequest): void {
      insertSorted(request);
    },

    dequeue(): GenerationRequest | undefined {
      return items.shift();
    },

    peek(): GenerationRequest | undefined {
      return items[0];
    },

    get size(): number {
      return items.length;
    },

    clear(): void {
      items.length = 0;
    },
  };
}
