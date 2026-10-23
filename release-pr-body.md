Automated version bump based on merged PR #12.

Release level: `release:minor`

## Release summary

This PR prepares a new npm release. Confirm that the selected version bump is
appropriate for the changes included since the previous npm release.

- Proposed version: verify the `package.json` version matches the `chore: release vX.Y.Z` PR title
- Release type: exactly one of `release:patch`, `release:minor`, or `release:major`
- Breaking changes: call out any API migration users need to make
- User-facing changes: add or confirm a concise summary

## Pre-publish checklist

- [ ] The version bump is intentional and appropriate for the included changes.
- [ ] The version in `package.json` matches the release PR title.
- [ ] The release level is appropriate for the included changes.
- [ ] Breaking changes are documented and use an appropriate major-version bump.
- [ ] User-facing changes and migration notes are documented.
- [ ] `pnpm release:check` passes.
- [ ] `pnpm pack --dry-run` contains the expected package files.
- [ ] Package exports and generated type declarations are present in the tarball.
- [ ] npm trusted publishing is configured for `.github/workflows/publish.yml`.

## After merging

After this release PR is merged, create and push the matching
`vMAJOR.MINOR.PATCH` tag to start the automated npm publish workflow. For
example, for version `1.2.3`, run `git tag v1.2.3 && git push origin v1.2.3`.
Confirm the workflow succeeds and the new version is visible on npm before
announcing the release.
