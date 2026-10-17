# Contributing to use-idb

Thank you for your interest in contributing to `use-idb`! We welcome contributions to performance, security, and developer ergonomics.

## Development Setup

1. **Clone the repository:**
   ```bash
   git clone https://github.com/inevitableDivu/use-idb.git
   cd use-idb
   ```

2. **Install dependencies:**
   ```bash
   pnpm install
   ```

3. **Run tests:**
   ```bash
   pnpm test
   ```

4. **Verify static analysis:**
   ```bash
   pnpm typecheck
   pnpm lint
   ```

5. **Build:**
   ```bash
   pnpm build
   ```

## Pull Request Guidelines

- Ensure all existing and new tests pass (`pnpm test`).
- Maintain zero external runtime dependencies.
- Follow Conventional Commits (`feat:`, `fix:`, `docs:`, `chore:`).
- Verify bundle size remains minimal (`< 4.5 kB` min+gzip).
