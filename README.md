# A GitHub-compatible git forge

One process, no UI, no dependencies: git smart HTTP (upload-pack v2, receive-pack v0), the REST v3
API, GraphQL v4 and an MCP endpoint, all served from a single in-memory store. Every surface reads
and writes the same objects, so a clone, a REST read and an MCP tool call can never disagree.

- `git smart HTTP` — `/<owner>/<repo>.git/{info/refs,git-upload-pack,git-receive-pack}`: protocol v2
  `ls-refs` and `fetch` (wants, haves, shallow depth, sideband packfile), v0 push with
  `report-status`, fast-forward enforcement and per-ref `ng` reports.
- `REST v3` — `/api/v3`: repositories, branches, commits, contents (file and directory), labels,
  issues, comments, pull requests, their files and a squash merge.
- `GraphQL v4` — `/api/graphql`: the documents `gh` and `github-mcp-server` send, plus `__type`
  introspection.
- `MCP` — `/mcp`: JSON-RPC 2.0 over Streamable HTTP with `server/discover`, `tools/list` and
  `tools/call` for repositories, issues and pull requests.

## Run it

```sh
node main.ts
```

The entry lifecycle is the harness's: with `MAKEFUN_ENV_URL` set it binds an ephemeral port, registers
it, and exits 0 once the env says the trial is done. Without it, there is nothing to talk to and the
program exits 1.

## Layout

| File | What it is |
| --- | --- |
| `main.ts` | the entry <-> env lifecycle |
| `app.ts` | the HTTP router and auth |
| `store.ts` | the store: repositories, objects, refs, issues, pull requests |
| `git.ts` | the object model and packfile codec (no git binary, no dependencies) |
| `smart.ts` | git smart HTTP, v2 fetch and v0 push |
| `rest.ts` | REST v3 |
| `graphql.ts` | the GraphQL parser and executor |
| `mcp.ts` | the MCP JSON-RPC surface |

MIT licensed.
