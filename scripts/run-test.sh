#!/usr/bin/env bash

set -e

npx tsc \
    --skipLibCheck \
    ./test/example.ts \
    --noEmit
