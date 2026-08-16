---
name: release-wr
description: Release the wr CLI to GitHub and Homebrew. Use when the user asks to prepare, cut, publish, monitor, repair, or verify a wr version release, including package version alignment, main CI, vX.Y.Z tag creation, GitHub Release assets, and mkusaka/homebrew-tap Formula updates.
---

# Release wr

Release `wr` from `main` through the tag-driven `.github/workflows/release.yml`. Treat the Git tag, GitHub Release, and Homebrew Formula as separate states and verify each one.

## Establish the target

1. Work from the repository root on `main`.
2. Fetch `origin/main` and tags.
3. Require a clean working tree unless the user explicitly included pending changes in the release.
4. Read the current version from `package.json` and existing semantic tags.
5. Get the intended version or bump from the user when it is not explicit.
6. Use the exact tag `v<package-version>`.

Do not tag a version that differs from `package.json`; the workflow rejects it. Do not use `bun pm version`, because it creates a tag before main CI is verified.

If the package version must change, update it without tagging:

```bash
bun pm pkg set version=X.Y.Z
bun install --lockfile-only
```

## Check release prerequisites

Do not repeat format, lint, typecheck, test, compile, or workflow validation locally solely for the release. The exact-head `CI` run is the release gate for those checks.

Confirm the repository secret exists without reading its value:

```bash
gh secret list --repo mkusaka/wr | rg '^HOMEBREW_TAP_TOKEN\b'
```

If preparing a version commit, inspect recent commit messages, stage only the version files, run `~/.codex/bin/codex-secret-scan`, and commit in repository style.

## Publish main first

1. Push `main`.
2. Read back the remote SHA.
3. Find the `CI` run whose `headSha` equals that exact SHA.
4. Wait for that run to succeed.

```bash
git push origin main
git ls-remote origin refs/heads/main
gh run list --repo mkusaka/wr --branch main --limit 10 \
  --json databaseId,headSha,workflowName,status,conclusion,url
gh run watch <run-id> --repo mkusaka/wr --exit-status
```

Do not create the release tag while exact-head CI is failing or still running.

## Create the release tag

Check that the tag and release do not already exist. Never move or replace an existing release tag.

```bash
VERSION=X.Y.Z
git tag -a "v${VERSION}" -m "wr v${VERSION}"
git push origin "v${VERSION}"
```

Tag push starts `Release`. `workflow_dispatch` is only suitable when invoked at an existing matching tag ref; dispatching it from `main` fails version validation.

## Monitor delivery

Find the Release run for the exact tag SHA and wait for all jobs:

```bash
gh run list --repo mkusaka/wr --workflow Release --limit 10 \
  --json databaseId,headSha,status,conclusion,url
gh run watch <run-id> --repo mkusaka/wr --exit-status
```

The successful path is:

1. Verify source checks.
2. Create a draft GitHub Release.
3. Compile and upload macOS arm64 and x64 archives.
4. Publish the release.
5. Dispatch the rendered Formula to `mkusaka/homebrew-tap`.

## Verify completion

Do not report the release complete until all of these are true:

- The exact Release run succeeded.
- `gh release view vX.Y.Z` reports a published, non-draft release.
- Both `wr-X.Y.Z-darwin-arm64.tar.gz` and `wr-X.Y.Z-darwin-x64.tar.gz` exist.
- `mkusaka/homebrew-tap` contains `Formula/wr.rb` with version `X.Y.Z` and both release URLs.

Use readbacks such as:

```bash
gh release view "v${VERSION}" --repo mkusaka/wr \
  --json tagName,isDraft,url,assets
gh api repos/mkusaka/homebrew-tap/contents/Formula/wr.rb \
  --jq '.content' | base64 --decode
```

Optionally run `brew install` or `brew upgrade` only when the user asks for a local installation smoke test.

## Handle failures safely

- For CI or Release failures, inspect `gh run view <run-id> --log-failed`, fix the observed cause, and repeat the appropriate gate.
- If a draft release remains, inspect it before retrying; do not delete it automatically.
- If the tag exists but delivery failed, repair and rerun the workflow at that same tag only when the release source does not need to change.
- If release source must change, stop and ask how to version the correction. Do not force-push or retag.
- If tap dispatch succeeds but Formula readback remains stale, inspect the latest `update-formula.yml` run in `mkusaka/homebrew-tap`.

Report the main SHA, tag SHA, CI result, Release result, asset names, Formula version, and any remaining manual action as separate facts.
