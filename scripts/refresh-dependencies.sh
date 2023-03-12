#!/usr/bin/env bash

set -e

PROJECT_ROOT=$(pwd)

TMP_DIRECTORY_NAME="tmp"
METEOR_PROJECT_NAME="stupid-hack-for-types"

# 1. Cleanup Directories
rm -rf ./node_modules
rm -rf /${TMP_DIRECTORY_NAME}/${METEOR_PROJECT_NAME}

# 2. Acquire Meteor TypeScript Definitions
# Temporarily to /tmp...
cd /${TMP_DIRECTORY_NAME}

# Create Project to Rob...
meteor create --typescript ${METEOR_PROJECT_NAME}
cd ${METEOR_PROJECT_NAME}

meteor npm install --save-dev typescript

# Return to Project...
cd ${PROJECT_ROOT}

# Rob NPM Dependencies to Shut-Up TypeScript...
cp -aR /${TMP_DIRECTORY_NAME}/${METEOR_PROJECT_NAME}/node_modules/ .
