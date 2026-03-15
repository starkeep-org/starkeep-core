import { describe, it, expect } from "vitest";
import { createGenerationQueue } from "../src/generation-queue.js";
import type { StarkeepId } from "@starkeep/core";

describe("createGenerationQueue", () => {
  it("should enqueue and dequeue items", () => {
    const queue = createGenerationQueue();
    queue.enqueue({
      generatorId: "@test:dims",
      targetId: "record-1" as StarkeepId,
      mode: "queued",
    });

    expect(queue.size).toBe(1);

    const item = queue.dequeue();
    expect(item?.generatorId).toBe("@test:dims");
    expect(queue.size).toBe(0);
  });

  it("should dequeue by priority (highest first)", () => {
    const queue = createGenerationQueue();
    queue.enqueue({
      generatorId: "@test:low",
      targetId: "record-1" as StarkeepId,
      mode: "queued",
      priority: 1,
    });
    queue.enqueue({
      generatorId: "@test:high",
      targetId: "record-2" as StarkeepId,
      mode: "queued",
      priority: 10,
    });
    queue.enqueue({
      generatorId: "@test:medium",
      targetId: "record-3" as StarkeepId,
      mode: "queued",
      priority: 5,
    });

    expect(queue.dequeue()?.generatorId).toBe("@test:high");
    expect(queue.dequeue()?.generatorId).toBe("@test:medium");
    expect(queue.dequeue()?.generatorId).toBe("@test:low");
  });

  it("should return undefined when empty", () => {
    const queue = createGenerationQueue();

    expect(queue.dequeue()).toBeUndefined();
    expect(queue.peek()).toBeUndefined();
  });

  it("should peek without removing", () => {
    const queue = createGenerationQueue();
    queue.enqueue({
      generatorId: "@test:dims",
      targetId: "record-1" as StarkeepId,
      mode: "queued",
    });

    expect(queue.peek()?.generatorId).toBe("@test:dims");
    expect(queue.size).toBe(1);
  });

  it("should clear all items", () => {
    const queue = createGenerationQueue();
    queue.enqueue({
      generatorId: "@test:a",
      targetId: "record-1" as StarkeepId,
      mode: "queued",
    });
    queue.enqueue({
      generatorId: "@test:b",
      targetId: "record-2" as StarkeepId,
      mode: "queued",
    });

    queue.clear();
    expect(queue.size).toBe(0);
  });
});
