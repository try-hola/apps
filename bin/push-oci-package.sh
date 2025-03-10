#!/usr/bin/env bash
set -euo pipefail

# Check if required arguments are provided
if [ $# -lt 2 ]; then
  echo "Usage: $0 <package-name> <registry-path> [tag] [repository]"
  echo "Example: $0 oci-test ghcr.io/try-hola packages"
  exit 1
fi

PACKAGE_NAME=$1
REGISTRY_PATH=$2
TAG=${3:-latest}
REPOSITORY=${4:-}

# If repository is specified, include it in the path
if [ -n "$REPOSITORY" ]; then
  REGISTRY_PATH="$REGISTRY_PATH/$REPOSITORY"
fi

# Navigate to repository root
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$REPO_ROOT"

# Check if ORAS is installed
if ! command -v oras &> /dev/null; then
  echo "Error: ORAS CLI is not installed. Please install it first."
  echo "Visit: https://oras.land/docs/installation"
  exit 1
fi

# Install GitHub CLI if not already present
if ! command -v gh &> /dev/null; then
  echo "GitHub CLI not found. Visit https://cli.github.com/ for installation"
fi

# Check if package exists
if [ ! -d "src/$PACKAGE_NAME" ]; then
  echo "Error: Package '$PACKAGE_NAME' not found in src directory"
  exit 1
fi

# Get version from package.json
VERSION=$(jq -r .version "src/$PACKAGE_NAME/package.json")
if [ "$VERSION" == "null" ]; then
  echo "Error: Unable to extract version from package.json"
  exit 1
fi

echo "Packaging $PACKAGE_NAME version $VERSION..."

# Create a temporary directory for building and cleanup afterward
TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT

# Create tarball in the temporary directory that includes both src contents and package.json
echo "Creating package tarball in temporary directory..."
TARBALL_PATH="$TEMP_DIR/$PACKAGE_NAME-v$VERSION.tgz"

# Create a temporary structure directory to organize files for tarball
STRUCTURE_DIR="$TEMP_DIR/structure"
mkdir -p "$STRUCTURE_DIR"

# Copy package.json to the structure directory for inclusion
cp "src/$PACKAGE_NAME/package.json" "$STRUCTURE_DIR/package.json"

# Copy all files from the src directory
mkdir -p "$STRUCTURE_DIR/src"
cp -r "src/$PACKAGE_NAME/src/"* "$STRUCTURE_DIR/src/"

# Create the tarball from the structure directory
tar -czf "$TARBALL_PATH" -C "$STRUCTURE_DIR" .

# Extract OCI annotations from package.json if they exist
ANNOTATIONS=""
if jq -e '.oci.annotations' "src/$PACKAGE_NAME/package.json" > /dev/null 2>&1; then
  # Process each annotation as an ORAS annotation
  jq -r '.oci.annotations | to_entries[] | "--annotation \"\(.key)=\(.value)\""' "src/$PACKAGE_NAME/package.json" > "$TEMP_DIR/annotations.txt"
  ANNOTATIONS=$(cat "$TEMP_DIR/annotations.txt" | tr '\n' ' ')
fi

# Confirm before pushing
echo -e "\nReady to push package to OCI registry:"
echo "  Package:  $PACKAGE_NAME"
echo "  Version:  $VERSION"
echo "  Registry: $REGISTRY_PATH"
echo "  Tags:     $VERSION" $([ "$TAG" == "latest" ] && echo "and latest")

# Debug output to verify paths
echo "Debug: Publishing $PACKAGE_NAME to registry path $REGISTRY_PATH"
echo "Debug: Full package path will be $REGISTRY_PATH/$PACKAGE_NAME"

read -p "Do you want to continue? (y/n): " confirm_push
if [[ ! "$confirm_push" =~ ^[Yy]$ ]]; then
  echo "Push cancelled."
  exit 0
fi

# Push to OCI registry using ORAS
echo "Pushing to $REGISTRY_PATH/$PACKAGE_NAME:$VERSION..."

# Instead of pushing to:
# ghcr.io/organization/package-name

# Push to a specific repository:
# ghcr.io/organization/repository-name/package-name

# Build the ORAS command with repository path
ORAS_CMD="oras push $REGISTRY_PATH/$PACKAGE_NAME:$VERSION $TARBALL_PATH"
if [ -n "$ANNOTATIONS" ]; then
  ORAS_CMD="$ORAS_CMD $ANNOTATIONS"
fi

# Replace template variables in annotations
ORAS_CMD=$(echo "$ORAS_CMD" | sed "s/\${npm_package_version}/$VERSION/g")

# Add the path validation disable flag
ORAS_CMD="$ORAS_CMD --disable-path-validation"

echo "Executing: $ORAS_CMD"
eval "$ORAS_CMD"

# Also push as latest if requested
if [ "$TAG" == "latest" ]; then
  echo "Pushing to $REGISTRY_PATH/$PACKAGE_NAME:latest..."
  LATEST_CMD="oras push $REGISTRY_PATH/$PACKAGE_NAME:latest $TARBALL_PATH"
  if [ -n "$ANNOTATIONS" ]; then
    LATEST_CMD="$LATEST_CMD $ANNOTATIONS"
  fi
  LATEST_CMD=$(echo "$LATEST_CMD" | sed "s/\${npm_package_version}/$VERSION/g")
  # Add the path validation disable flag for the latest tag push as well
  LATEST_CMD="$LATEST_CMD --disable-path-validation"
  eval "$LATEST_CMD"
fi

# Extract GitHub organization from registry path
# Registry path is typically in format like ghcr.io/organization-name
GITHUB_ORG=$(echo "$REGISTRY_PATH" | awk -F'/' '{print $2}')

# Set package visibility to public
echo "Setting package visibility to public..."
gh api \
  --method PATCH \
  -H "Accept: application/vnd.github.v3+json" \
  /orgs/$GITHUB_ORG/packages/container/$PACKAGE_NAME/visibility \
  -f visibility=public

echo "Successfully pushed $PACKAGE_NAME version $VERSION to $REGISTRY_PATH/$PACKAGE_NAME"