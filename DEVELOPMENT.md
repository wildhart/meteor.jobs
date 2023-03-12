
# Development

## Meteor Publication

TODO: Write Me!

## Type Definitions

Meteor does not provide a mechanism to expose type definitions to consumers when using `meteor add package@version`. As such, we provide a copy-paste type definition file `wildhart-jobs.d.ts` in order to ease developer burden.

The folling can be used to generate and test new type definition files to be committed as a part of the development process. See Also: [Scripts](#scripts)

```
~/source/meteor.jobs$ ./scripts/refresh-dependencies.sh
~/source/meteor.jobs$ ./scripts/refresh-types.sh
~/source/meteor.jobs$ ./scripts/run-test.sh
```

### Scripts

#### /scripts/refresh-dependencies.md

Meteor packages do not appear to provide a graceful way of installing dependencies as compared to Meteor applications, i.e. `meteor npm ci`. As such, we have a script that uses `meteor create --typescript` to create a scaffold and then steal the installed `node_modules` for our use.

TODO: Find Meteor-idiomatic way of handling packages!

```
~/source/meteor.jobs$ ./scripts/refresh-dependencies.sh
```

#### /scripts/refresh-types.md

Runs `npx tsc` with additional options to generate our type definitions in `jobs.d.ts`. Copies `jobs.d.ts` into `wildhart-jobs.d.ts` in order to export the same type definitions in a module named with the Meteor package format, `meteor/wildhart:jobs`.

```
~/source/meteor.jobs$ ./scripts/refresh-types.sh
```

#### /scripts/run-test.md

Runs `npx tsc` with additional options to test our sample invocations in `/test/example.ts`.

```
~/source/meteor.jobs$ ./scripts/run-test.sh
```
