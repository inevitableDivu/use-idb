import { createContext, useContext, useMemo, type ReactNode } from "react";
import { Engine, getDefaultEngine } from "../core/engine";

const DatabaseContext = createContext<Engine | null>(null);

export interface IndexedDBProviderProps {
  client?: Engine;
  children: ReactNode;
}

/**
 * React context provider for the use-idb Engine.
 * If no client is passed, binds to the default zero-config singleton engine.
 */
export function IndexedDBProvider({ client, children }: IndexedDBProviderProps) {
  const engine = useMemo(() => client ?? getDefaultEngine(), [client]);

  return <DatabaseContext.Provider value={engine}>{children}</DatabaseContext.Provider>;
}

/**
 * Access the active Engine instance from React Context.
 * If used outside <IndexedDBProvider>, seamlessly falls back to the default singleton engine.
 */
export function useDatabase(): Engine {
  const context = useContext(DatabaseContext);
  return context ?? getDefaultEngine();
}
