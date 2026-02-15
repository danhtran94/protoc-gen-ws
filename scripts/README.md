# Release Scripts

## release.sh

Automates the TypeScript package release process using GitHub Releases.

### Prerequisites

- [GitHub CLI (`gh`)](https://cli.github.com/) installed and authenticated
- Clean git working directory (no uncommitted changes)
- npm installed

### Usage

```bash
# Interactive mode (will prompt for version)
./scripts/release.sh

# Or specify version directly
./scripts/release.sh 1.0.0

# Or use make
make release
```

### What it does

1. ✅ Validates version format (semver: X.Y.Z)
2. ✅ Checks for uncommitted changes
3. ✅ Updates `ts/package.json` version
4. ✅ Commits version bump
5. ✅ Installs dependencies (`npm ci`)
6. ✅ Runs tests (`npm test`)
7. ✅ Builds TypeScript package (`npm run build`)
8. ✅ Creates tarball (`npm pack`)
9. ✅ Creates and pushes git tag (`vX.Y.Z`)
10. ✅ Creates GitHub release with tarball attached
11. ✅ Prints installation instructions

### Example

```bash
$ ./scripts/release.sh 1.0.0

Creating release v1.0.0...
Updating package.json version...
Installing dependencies...
Running tests...
Building TypeScript package...
Creating tarball...
Created tarball: protoc-gen-ws-1.0.0.tgz
Creating git tag v1.0.0...
Pushing tag to remote...

Enter release notes (press Ctrl+D when done):
Initial release

Features:
- Full yamux implementation
- TypeScript runtime and code generation
- All RPC patterns supported
^D

Creating GitHub release...
✅ Release v1.0.0 created successfully!

Installation instructions for users:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
npm install https://github.com/danhtran94/protoc-gen-ws/releases/download/v1.0.0/protoc-gen-ws-1.0.0.tgz
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
```

### Error Handling

The script will exit with an error if:
- `gh` CLI is not installed
- Not run from repository root
- Uncommitted changes exist
- Invalid version format
- Tag already exists
- Tests fail
- Build fails

### Release Notes

You can provide release notes in two ways:

1. **Interactive** (prompted during script execution):
   ```bash
   ./scripts/release.sh 1.0.0
   # Will prompt for release notes
   ```

2. **Auto-generated** (skip the prompt with Ctrl+D):
   ```bash
   ./scripts/release.sh 1.0.0
   # Press Ctrl+D immediately to use GitHub's auto-generated notes
   ```

### Rollback

If something goes wrong after pushing the tag:

```bash
# Delete local tag
git tag -d v1.0.0

# Delete remote tag
git push --delete origin v1.0.0

# Delete GitHub release
gh release delete v1.0.0

# Reset version bump commit
git reset --hard HEAD~1
git push -f origin main
```
