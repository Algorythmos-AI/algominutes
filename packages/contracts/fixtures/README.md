# Contract fixtures

Real-shaped `/v1` response bodies, one file per response, several cases each (including an older server's
answer where a field was added later). Each is checked twice:

- `tests/contract-fixtures.test.ts` parses every case with its zod schema, and fails if the schema would drop or
  refuse anything: the fixtures are what the server may send.
- iOS's `ContractFixturesTests` decodes the same files with the app's own models, so a contract change the app
  can't read fails its tests, not a tester's phone.

Add a case when a response gains a field or a state; add a file when a client starts decoding a new response.
