#!/usr/bin/env bash

set -e

JOB_SOURCE="jobs.ts"
JOB_DEFINITION_SOURCE="jobs.d.ts"
MODULE_NAME="meteor/wildhart:jobs"
MODULE_SOURCE="wildhart-jobs.d.ts"

# Build w/
#   `jobs.ts`
#       `package.js` Irrelevant to Types...
#   `--skipLibCheck`
#   `--declaration`
#       We want the `jobs.d.ts` output...
#   `--emitDeclarationOnly`
#       We do not want the `jobs.js` output...
npx tsc \
    ${JOB_SOURCE} \
    --skipLibCheck \
    --declaration \
    --emitDeclarationOnly

# 1. Catenate Type Definition File
# 2. Prepend Tab per Line
    # See: https://unix.stackexchange.com/a/552704
TYPES=$(cat ./${JOB_DEFINITION_SOURCE} | ( TAB=$'\t' ; sed "s/^/$TAB/" ))

# Create Type Definition for Meteor Package Convention
echo "
declare module '${MODULE_NAME}' {
${TYPES}
}
" > ${MODULE_SOURCE}
