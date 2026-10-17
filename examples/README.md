# use-idb examples

These examples show common IndexedDB and React use cases with typed stores. They
use this package's public entry point; in another project, install the package
and use the package name from your dependency manifest.

| Example                                                  | What it demonstrates                                      |
| -------------------------------------------------------- | --------------------------------------------------------- |
| [Typed notes](./typed-notes.ts)                          | Typed CRUD, date indexes, and range queries               |
| [Reactive todo list](./reactive-todo-list.tsx)           | Live queries and store-scoped React mutations             |
| [Tagged product catalog](./tagged-product-catalog.ts)    | Multi-entry indexes and element-level tag search          |
| [Offline sync outbox](./offline-sync-outbox.ts)          | Persisting pending work and draining it after reconnect   |
| [Compound-key settings](./compound-key-settings.ts)      | Compound primary keys and per-user records                |
| [Schema migration](./schema-migration.ts)                | Synchronous version upgrades that transform stored data   |
| [Atomic checkout](./atomic-checkout.ts)                  | Updating inventory and creating orders in one transaction |
| [Encrypted private notes](./encrypted-private-notes.ts)  | AES-GCM field encryption and key handling                 |
| [Cross-tab notifications](./cross-tab-notifications.tsx) | Live UI updates propagated between browser tabs           |
| [Bulk import/export](./bulk-import-export.ts)            | Typed data backup and bulk restore                        |

The `.ts` examples run in a browser environment with IndexedDB. The React
example is a component intended to be rendered by a React application. For
example, add the source to a Vite or other TypeScript application, then import
the component or call the exported demo function from that application's UI.

These are starting points, not a substitute for application-specific error
handling, validation, or server-side conflict resolution. The outbox example
keeps a failed item in IndexedDB by deleting it only after the supplied sender
resolves successfully.

Security-sensitive examples require special care: migrations must remain
synchronous, and the encryption example expects an application-managed key.
Do not persist an encryption key beside the ciphertext; provision and retain it
using an appropriate platform or server-backed key-management strategy. The
sample key-generation helper is suitable only for demonstrating the API: a
non-extractable key generated in memory cannot decrypt saved data after a reload
unless the application securely persists or re-derives the key.
