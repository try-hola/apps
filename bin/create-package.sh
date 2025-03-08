#!/bin/bash

# Create a new package in the monorepo
# Usage: ./create-package.sh package-name

set -e

if [ -z "$1" ]; then
  echo "Error: Package name is required"
  echo "Usage: ./create-package.sh package-name"
  exit 1
fi

PACKAGE_NAME="$1"
PACKAGE_DIR="packages/$PACKAGE_NAME"

if [ -d "$PACKAGE_DIR" ]; then
  echo "Error: Package $PACKAGE_NAME already exists"
  exit 1
fi

# Create package structure
mkdir -p "$PACKAGE_DIR/src"

# Create package.json
cat > "$PACKAGE_DIR/package.json" << EOF
{
  "name": "$PACKAGE_NAME",
  "version": "0.1.0",
  "description": "$PACKAGE_NAME deployment package",
  "author": "",
  "license": "UNLICENSED"
}
EOF

# Create a basic docker-compose.yaml
cat > "$PACKAGE_DIR/src/docker-compose.yaml" << EOF
version: "3.8"

services:
  app:
    image: nginx:latest
    ports:
      - "8080:80"
EOF

# Create a basic README
cat > "$PACKAGE_DIR/README.md" << EOF
# $PACKAGE_NAME

## Overview

This package contains Docker Compose configuration for $PACKAGE_NAME.

## Usage

To use this package locally:

\`\`\`bash
cd src
docker-compose up
\`\`\`

## Versioning

Current version: 0.1.0
\`\`\`
EOF

echo "Package $PACKAGE_NAME created successfully!"
echo "Directory: $PACKAGE_DIR"
chmod +x "$PACKAGE_DIR/create-package.sh"