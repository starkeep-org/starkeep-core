import type { HLCClock, StarkeepId, MetadataRecord } from "@starkeep/core";
import type { DatabaseAdapter, MetadataColumnDefinition } from "@starkeep/storage-adapter";
import type { ObjectStorageAdapter } from "@starkeep/storage-adapter";

export type { MetadataColumnDefinition };

export interface GeneratingFunctionInput {
  readonly dataRecordId: StarkeepId;
  readonly targetType: string;
  readonly dependencyIds: StarkeepId[];
  readonly parameters: Record<string, unknown>;
}

export interface GeneratingFunctionOutput {
  readonly value: Record<string, unknown>;
}

export interface GeneratingFunctionDefinition {
  readonly generatorId: string;
  readonly generatorVersion: number;
  readonly inputTypes: string[];
  readonly dependsOn: string[];
  /**
   * Declares the SQL columns this generator writes into the per-type metadata
   * table. Column names are snake_case; values in GeneratingFunctionOutput.value
   * use the corresponding camelCase key (e.g. "group_id" ↔ "groupId").
   */
  readonly outputColumns: MetadataColumnDefinition[];
  generate(
    input: GeneratingFunctionInput,
    context: GenerationContext,
  ): Promise<GeneratingFunctionOutput>;
}

export interface GenerationContext {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly ownerId: string;
}

export type GenerationMode = "on-demand" | "queued";

export interface GenerationRequest {
  readonly generatorId: string;
  readonly targetId: StarkeepId;
  readonly targetType: string;
  readonly mode: GenerationMode;
  readonly priority?: number;
  readonly parameters?: Record<string, unknown>;
}

export interface GenerationResult {
  readonly metadataRecord: MetadataRecord;
  readonly wasStale: boolean;
  readonly skippedBecauseCached: boolean;
}

export interface MetadataMigration {
  readonly generatorId: string;
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(existingValue: Record<string, unknown>): Record<string, unknown>;
}

export interface GeneratorRegistry {
  register(definition: GeneratingFunctionDefinition): void;
  get(generatorId: string): GeneratingFunctionDefinition | undefined;
  getForType(dataType: string): GeneratingFunctionDefinition[];
  list(): GeneratingFunctionDefinition[];
}

export interface DependencyGraph {
  addGenerator(definition: GeneratingFunctionDefinition): void;
  getGenerationOrder(dataType: string): string[];
  getDependents(generatorId: string): string[];
  getDependencies(generatorId: string): string[];
  hasCycle(): boolean;
}

export interface GenerationQueue {
  enqueue(request: GenerationRequest): void;
  dequeue(): GenerationRequest | undefined;
  peek(): GenerationRequest | undefined;
  readonly size: number;
  clear(): void;
}

export interface MetadataEngine {
  generate(request: GenerationRequest): Promise<GenerationResult>;
  generateAll(targetId: StarkeepId, dataType: string): Promise<GenerationResult[]>;
  checkStaleness(targetId: StarkeepId, targetType: string, generatorId: string): Promise<boolean>;
}

export interface MetadataEngineOptions {
  readonly databaseAdapter: DatabaseAdapter;
  readonly objectStorageAdapter: ObjectStorageAdapter;
  readonly clock: HLCClock;
  readonly ownerId: string;
  readonly generatorRegistry: GeneratorRegistry;
  readonly dependencyGraph: DependencyGraph;
}

export interface MigrationRunner {
  registerMigration(migration: MetadataMigration): void;
  applyPendingMigrations(generatorId: string, targetType: string): Promise<number>;
  getMigrations(generatorId: string): MetadataMigration[];
}
