# CI for your project

Ratchet ships two reusable GitHub Actions workflows. A project calls them from a short workflow of its own instead of copying them. They run the project's own lint, type-check and tests on every merge; Ratchet's rules and built-in checks still run at each agent turn.

Pin each call to a commit of this repository, never to a branch, and keep the release tag next to it as a comment. Ratchet never moves its own release tags.

## The gate: `gate.yml`

The gate lints once on Linux, then type-checks and tests on each system you list.

`ratchet ci init` writes the caller for you:

```
ratchet ci init --os ubuntu-latest,windows-latest
```

It finds:
- the package with a test script, from the root down;
- its lint and type-check scripts;
- the Node version, from `.nvmrc`.

It pins the gate to the commit of your installed Ratchet's release tag, after checking that the gate is there.

The workflow it writes holds a `ci-ok` job that needs the gate. Keep `ci-ok` in your file: a job inside a reusable workflow is named `gate / …`, so a ruleset could never require it by name.

`ci init` writes a ruleset file and prints the command that makes `main` require `ci-ok`. You run that command; Ratchet never changes repository settings. The ruleset has no bypass, blocks force pushes and deletion, and accepts `ci-ok` only from GitHub Actions.

A private repository on GitHub's free plan cannot enforce a ruleset. There, check `main` after the fact, with a workflow that opens an issue for any commit that skipped CI.

Once the ruleset is on, prove that it refuses. Push a commit with a failing test to a branch protected the same way, and check that GitHub will not let it in.

## The release: `release.yml`

The release builds a tag's downloads on each system and puts them on that tag's release. It runs these steps:

1. It refuses a tag whose commit has no passing `ci-ok`.
2. It refuses an existing release unless you rebuild in place.
3. It builds on each system and checks that the built program reports the tag's version.
4. It packs each asset (`.tar.gz` or `.zip`).
5. It writes `SHA256SUMS.txt` and attests the files.
6. It creates the release, or replaces its files when rebuilding.
7. It downloads the files again and checks the sums.

A caller:

```yaml
name: Release
on:
  push:
    tags: ["v*.*.*"]
permissions:
  contents: write
  checks: read
  id-token: write
  attestations: write
jobs:
  release:
    uses: kootru-repo/trust-ratchet/.github/workflows/release.yml@<commit> # v<version>
    with:
      tag: ${{ github.ref_name }}
      targets: '[{"os":"macos-latest","asset":"app-macos-arm64.tar.gz"},{"os":"windows-2022","asset":"app-windows-x64.zip"}]'
      working-directory: app
      build-command: npm run build:exe
      dist-dir: dist/exe
      version-command: ./dist/exe/app --version
```

These inputs change how it runs:
- `rebuild-in-place: true` replaces the files of an existing release, and says so in its notes. It is off by default.
- `dry-run: true` rehearses the build, the version check and the checksums at the calling commit, and publishes nothing.

The files are attested by this workflow. To check one:

```
gh attestation verify app-windows-x64.zip --repo <owner>/<repo> --signer-workflow kootru-repo/trust-ratchet/.github/workflows/release.yml
```

## Pinning

Every action inside both workflows is pinned to a commit, with its version as a comment.

## Builds that say which commit they are (D4)

Make the built program print its version and commit: `app 1.2.3 (0123456789ab)`. Do the same in every report and screen that shows a version. The release workflow's `version-command` then checks that the build is the tag's version, and a bug report names the exact commit.

## Turning on a formatter safely (D5)

1. Measure first. Run the formatter in check mode at a few line widths and pick the one that changes the fewest lines.
2. Leave out recorded fixtures and generated files, and protect them (`builtin:protected`, `builtin:generated`).
3. Make one commit that only changes layout, at a time when no agent is editing the tree.
4. List that commit so `git blame` skips it, and make blame read the file:

   ```
   ratchet ci blame-ignore --commit <sha> --note "biome: layout only"
   git config blame.ignoreRevsFile .git-blame-ignore-revs
   ```

5. Only then make the lint check fail on unformatted code.

## Code scanning and real browsers (D6)

```
ratchet ci codeql
```

This writes a CodeQL workflow for JavaScript and TypeScript, pinned to commits. It runs on every push and pull request and weekly. It does not block merges unless you add it to the ruleset.

For a web interface, add a job of your own that drives a real browser (Playwright, or Safari on macOS) against the built pages. Keep it outside `ci-ok` until it is reliable.

## Prove the gate refuses (D7)

A ruleset that is set but never seen to refuse is a guess. After you turn it on, push a commit with a failing test to a branch protected the same way, and check that GitHub will not let it in. `ratchet ci init` prints this step.
