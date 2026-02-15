#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Helper functions
error() {
    echo -e "${RED}Error: $1${NC}" >&2
    exit 1
}

info() {
    echo -e "${GREEN}$1${NC}"
}

warn() {
    echo -e "${YELLOW}$1${NC}"
}

# Check if gh CLI is installed
if ! command -v gh &> /dev/null; then
    error "gh CLI is not installed. Install from: https://cli.github.com/"
fi

# Check if we're in the right directory
if [ ! -f "go.mod" ] || [ ! -d "ts" ]; then
    error "Must run from repository root"
fi

# Check for uncommitted changes
if ! git diff-index --quiet HEAD --; then
    error "Uncommitted changes detected. Commit or stash them first."
fi

# Get version from argument or prompt
VERSION=$1
if [ -z "$VERSION" ]; then
    read -p "Enter version (e.g., 1.0.0): " VERSION
fi

# Validate version format
if [[ ! "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
    error "Invalid version format. Use semver: X.Y.Z"
fi

TAG="v${VERSION}"

# Check if tag already exists
if git rev-parse "$TAG" >/dev/null 2>&1; then
    error "Tag $TAG already exists"
fi

info "Creating release $TAG..."

# Update version in package.json
info "Updating package.json version..."
cd ts
npm version "$VERSION" --no-git-tag-version
cd ..

# Commit version bump
git add ts/package.json ts/package-lock.json
git commit -m "chore: bump version to $VERSION"

# Build TypeScript package
info "Installing dependencies..."
cd ts
npm ci

info "Running tests..."
npm test

info "Building TypeScript package..."
npm run build

# Create tarball
info "Creating tarball..."
TARBALL=$(npm pack | tail -n 1)
TARBALL_NAME="protoc-gen-ws-${VERSION}.tgz"
mv "$TARBALL" "../${TARBALL_NAME}"
cd ..

info "Created tarball: $TARBALL_NAME"

# Create and push git tag
info "Creating git tag $TAG..."
git tag -a "$TAG" -m "Release $TAG"

info "Pushing tag to remote..."
git push origin main
git push origin "$TAG"

# Prompt for release notes
warn "\nEnter release notes (press Ctrl+D when done):"
RELEASE_NOTES=$(cat)

# Create GitHub release
info "\nCreating GitHub release..."
if [ -z "$RELEASE_NOTES" ]; then
    gh release create "$TAG" \
        "$TARBALL_NAME" \
        --title "$TAG" \
        --generate-notes
else
    gh release create "$TAG" \
        "$TARBALL_NAME" \
        --title "$TAG" \
        --notes "$RELEASE_NOTES"
fi

# Cleanup
info "Cleaning up tarball..."
rm "$TARBALL_NAME"

# Print installation instructions
info "\n✅ Release $TAG created successfully!"
echo ""
echo "Installation instructions for users:"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "npm install https://github.com/danhtran94/protoc-gen-ws/releases/download/$TAG/$TARBALL_NAME"
echo ""
echo "Or in package.json:"
echo ""
echo '{'
echo '  "dependencies": {'
echo "    \"protoc-gen-ws\": \"https://github.com/danhtran94/protoc-gen-ws/releases/download/$TAG/$TARBALL_NAME\""
echo '  }'
echo '}'
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
