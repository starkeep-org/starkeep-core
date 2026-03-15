import type * as v from "valibot";

export interface TypeDefinition {
  name: string;
  namespace: string;
  schema: v.BaseSchema<unknown, unknown, v.BaseIssue<unknown>>;
}

export interface TypeRegistry {
  register(definition: TypeDefinition): void;
  get(namespace: string, name: string): TypeDefinition | undefined;
  getByKey(key: string): TypeDefinition | undefined;
  has(namespace: string, name: string): boolean;
  list(): TypeDefinition[];
}

export function createTypeRegistry(): TypeRegistry {
  const types = new Map<string, TypeDefinition>();

  return {
    register(definition: TypeDefinition): void {
      const key = `${definition.namespace}:${definition.name}`;
      if (types.has(key)) {
        throw new Error(`Type "${key}" is already registered`);
      }
      types.set(key, definition);
    },

    get(namespace: string, name: string): TypeDefinition | undefined {
      return types.get(`${namespace}:${name}`);
    },

    getByKey(key: string): TypeDefinition | undefined {
      return types.get(key);
    },

    has(namespace: string, name: string): boolean {
      return types.has(`${namespace}:${name}`);
    },

    list(): TypeDefinition[] {
      return Array.from(types.values());
    },
  };
}
