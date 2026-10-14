import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Engine, getDefaultEngine } from "../core/engine";

const DatabaseContext = createContext<Engine | null>(null);

/**
 * Props for the {@link IndexedDBProvider} component.
 */
export interface IndexedDBProviderProps {
  /**
   * Custom configured {@link Engine} instance.
   * If omitted, the provider automatically binds to the default zero-config singleton engine.
   */
  client?: Engine;

  /**
   * React component subtree with access to the database context.
   */
  children: ReactNode;
}

/**
 * React context provider supplying an active {@link Engine} client to all descendant hooks
 * (`useIdb`, `useLiveQuery`, `useRecord`, `useMutation`, `useIDBStatus`).
 *
 * @param props - Component props containing optional `client` and `children`.
 * @returns JSX Element providing database context.
 *
 * @example
 * ```tsx
 * import { IndexedDBProvider, createDatabase } from "use-idb";
 *
 * const db = createDatabase({
 *   name: "my-app-db",
 *   version: 1,
 *   stores: {
 *     todos: { keyPath: "id" },
 *   },
 * });
 *
 * export function App() {
 *   return (
 *     <IndexedDBProvider client={db}>
 *       <TodoList />
 *     </IndexedDBProvider>
 *   );
 * }
 * ```
 */
export function IndexedDBProvider({ client, children }: IndexedDBProviderProps) {
  const engine = useMemo(() => client ?? getDefaultEngine(), [client]);

  return <DatabaseContext.Provider value={engine}>{children}</DatabaseContext.Provider>;
}

/**
 * Access the active {@link Engine} instance from React Context.
 *
 * If called outside an `<IndexedDBProvider>`, seamlessly falls back to the default singleton engine.
 *
 * @returns The active {@link Engine} instance.
 *
 * @example
 * ```tsx
 * const db = useDatabase();
 * const users = await db.query("users").toArray();
 * ```
 */
export function useDatabase(): Engine {
  const context = useContext(DatabaseContext);
  return context ?? getDefaultEngine();
}
