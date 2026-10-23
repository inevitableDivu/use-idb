import type { DatabaseSchema, StoreConfig, IndexConfig } from "../types/schema";
import type { Engine } from "./engine";
import type { ResolvedEngineConfig } from "./config";
import { DatabaseConfigurationConflictError } from "./errors";

type Registration = {
  schemaSignature: string;
  runtimeSignature: string;
  storage?: ResolvedEngineConfig["adapters"]["storage"];
  sync?: ResolvedEngineConfig["adapters"]["sync"];
  lock?: ResolvedEngineConfig["adapters"]["lock"];
  middleware: readonly ResolvedEngineConfig["middleware"][number][];
};

const enginesByName = new Map<string, Engine<any>>();
const registrations = new WeakMap<Engine<any>, Registration>();
const functionIds = new WeakMap<object, number>();
let nextFunctionId = 1;

function identityOf(value: object): number {
  let id = functionIds.get(value);
  if (id === undefined) {
    id = nextFunctionId++;
    functionIds.set(value, id);
  }
  return id;
}

function getSchemaSignature(schema: DatabaseSchema<any>): string {
  const migrations = Object.entries(schema.migrations ?? {})
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([version, migration]) => [version, identityOf(migration)]);

  const stores = Object.fromEntries(
    Object.entries(schema.stores as Record<string, StoreConfig<any, any>>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([name, store]) => [
        name,
        {
          keyPath: store.keyPath ?? null,
          autoIncrement: store.autoIncrement ?? false,
          indexes: Object.fromEntries(
            Object.entries(store.indexes ?? ({} as Record<string, IndexConfig<any>>))
              .sort(([left], [right]) => left.localeCompare(right))
              .map(([indexName, index]) => [
                indexName,
                {
                  keyPath: index.keyPath,
                  unique: index.unique ?? false,
                  multiEntry: index.multiEntry ?? false,
                },
              ]),
          ),
        },
      ]),
  );

  return JSON.stringify({
    name: schema.name,
    version: schema.version,
    stores,
    migrations,
    // Included for legacy compatibility while schema.options is deprecated.
    options: schema.options ?? {},
  });
}

function getRuntimeSignature(config: ResolvedEngineConfig): string {
  return JSON.stringify({
    cache: config.cache,
    writes: config.writes,
    crossTab: config.crossTab,
    fallback: config.fallback,
    diagnostics: {
      onEvent: config.diagnostics?.onEvent ? identityOf(config.diagnostics.onEvent) : null,
      onError: config.diagnostics?.onError ? identityOf(config.diagnostics.onError) : null,
    },
  });
}

function sameMiddlewareChain(
  left: readonly ResolvedEngineConfig["middleware"][number][],
  right: readonly ResolvedEngineConfig["middleware"][number][],
): boolean {
  return (
    left.length === right.length && left.every((middleware, index) => middleware === right[index])
  );
}

/** Return a registered engine without exposing the mutable registry itself. */
export function findRegisteredEngine<TSchema extends DatabaseSchema<any> = DatabaseSchema<any>>(
  name: string,
): Engine<TSchema> | undefined {
  return enginesByName.get(name) as Engine<TSchema> | undefined;
}

/** Ensure re-registration cannot silently change storage, synchronization, locking, or crypto middleware. */
export function assertCompatibleEngineRegistration(
  existing: Engine<any>,
  schema: DatabaseSchema<any>,
  config: ResolvedEngineConfig,
): void {
  const registered = registrations.get(existing);
  if (!registered) return;

  const conflicts: string[] = [];
  if (registered.schemaSignature !== getSchemaSignature(schema)) conflicts.push("schema");
  if (registered.storage !== config.adapters.storage) conflicts.push("storage adapter");
  if (registered.sync !== config.adapters.sync) conflicts.push("sync adapter");
  if (registered.lock !== config.adapters.lock) conflicts.push("lock adapter");
  if (!sameMiddlewareChain(registered.middleware, config.middleware)) conflicts.push("middleware");
  if (registered.runtimeSignature !== getRuntimeSignature(config))
    conflicts.push("runtime options");

  if (conflicts.length > 0) {
    throw new DatabaseConfigurationConflictError(schema.name, conflicts);
  }
}

/** Register a fully configured engine. Called only by createDatabase after construction succeeds. */
export function registerEngine(
  schema: DatabaseSchema<any>,
  engine: Engine<any>,
  config: ResolvedEngineConfig,
): void {
  registrations.set(engine, {
    schemaSignature: getSchemaSignature(schema),
    runtimeSignature: getRuntimeSignature(config),
    storage: config.adapters.storage,
    sync: config.adapters.sync,
    lock: config.adapters.lock,
    middleware: [...config.middleware],
  });
  enginesByName.set(schema.name, engine);
}

/** Remove a name only if it still points at this exact engine instance. */
export function unregisterEngine(name: string, engine: Engine<any>): void {
  if (enginesByName.get(name) === engine) enginesByName.delete(name);
}
