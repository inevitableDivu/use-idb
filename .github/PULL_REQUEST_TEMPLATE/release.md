## Release summary

This PR is the release-version PR. Automation has upversioned `package.json`
from the release label on the merged feature PR. Review the changes included
since the previous npm release and confirm that this version bump is
appropriate.

- Proposed version: verify the `package.json` version matches the `chore: release vX.Y.Z` PR title
- Release type: exactly one of `release:patch`, `release:minor`, or `release:major`
- User-facing changes: add or confirm a concise summary

## Pre-publish checklist

- [ ] The source feature PR has the correct release label; automation applied that bump to `package.json`.
- [ ] The version in `package.json` matches the release PR title.
- [ ] The release level is appropriate for the included changes.
- [ ] User-facing changes and migration notes are documented.
- [ ] `pnpm release:check` passes.
- [ ] `pnpm pack --dry-run` contains the expected package files.
- [ ] Package exports and generated type declarations are present in the tarball.
- [ ] npm trusted publishing is configured for `.github/workflows/publish.yml`.

## After merging

Merging this PR creates the matching `vMAJOR.MINOR.PATCH` tag and starts the
automated npm publish workflow. Confirm the workflow succeeds and the new
version is visible on npm before announcing the release.
