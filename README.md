# use-idb

A lightweight, type-safe React hook wrapper for IndexedDB.

## Features (Proposed)

- 🪝 Idiomatic React Hook API (`useIdb`)
- 🔒 Type-safe key-value and object store access
- ⚡ Minimal footprint with zero or near-zero runtime overhead
- 🔄 Cross-tab & multi-component state synchronization
- 🛡️ Safe SSR handling (graceful fallback in non-browser environments)
- 🧪 Fully testable with in-memory IndexedDB polyfills

## Getting Started

### Installation

```bash
pnpm add use-idb
# or
npm install use-idb
```

### Basic Usage

```tsx
import { useIdb } from "use-idb";

function Profile() {
  const { value, setValue, loading, error } = useIdb("user-profile", {
    defaultValue: { name: "Guest" },
  });

  if (loading) return <div>Loading...</div>;
  if (error) return <div>Error: {error.message}</div>;

  return (
    <div>
      <p>Name: {value?.name}</p>
      <button onClick={() => setValue({ name: "Alice" })}>Update</button>
    </div>
  );
}
```

## Scripts

- `pnpm build`: Build the library using tsup (CJS, ESM, and `.d.ts`)
- `pnpm test`: Run test suite with Vitest and fake-indexeddb
- `pnpm typecheck`: Type check without emitting
