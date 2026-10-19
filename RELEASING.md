# Releasing

`opencode-hermes` and `opencode-hermes-embeddings` are a pair: the host and its
optional provider. They share **one version number**. A release bumps both,
even when one repo has no code change, so the same number always means a tested
pair.

Both a **tag** and a **GitHub Release** are part of a release. The tag is the
Git truth; the release is the human-facing page, built from the tag message.

## Checklist

1. Pick the version (semver for the pair).
2. In both repos, bump `package.json` and update the README "Versioning" line.
3. Commit in both, with the same message:
   ```bash
   git commit -m "chore: vX.Y.Z (version lockstep with <companion>)"
   ```
4. Write the release notes to a file (include the tested pair and any
   requirements), then create an annotated tag in both repos:
   ```bash
   git tag -a vX.Y.Z -F /tmp/notes.md
   ```
5. Push the commits and tags:
   ```bash
   git push origin main
   git push origin vX.Y.Z
   ```
6. Create the GitHub Release from the annotated tag:
   ```bash
   gh release create vX.Y.Z --title "vX.Y.Z" --notes-from-tag --verify-tag
   ```
7. Verify:
   ```bash
   gh release view vX.Y.Z
   gh release list
   ```
   Only the newest release should be marked **Latest**.

## Notes

- Do not create a release without a tag, or a tag without a release.
- `--notes-from-tag` reads the annotated tag message, so keep the notes there.
- The provider is optional: `opencode-hermes` works without it, but the
  versions still move together.
- Older tags are backfilled as releases for consistency; the tags remain the
  source of truth.
