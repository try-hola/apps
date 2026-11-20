# omnigraph

[Omnigraph](https://github.com/ModernRelay/omnigraph) is a graph database built for AI agents
that share one typed model of a domain. A `.pg` schema declares node and edge types and the engine
enforces it on every write. One query can combine graph traversal, vector search and full-text
search. Branches, three-way merges and time travel cover the whole graph, so an agent can propose a
change on its own branch instead of writing to `main`. Cedar policies decide who may do what. Data
is stored in the open [Lance](https://github.com/lance-format/lance) format. MIT-licensed, by
ModernRelay. Hola is not affiliated with them.

This package runs **`omnigraph-server`**. It has no web UI: it serves an HTTP API and an MCP
endpoint on one port. People use the [`omnigraph` CLI](https://github.com/ModernRelay/omnigraph#install),
the [TypeScript SDK](https://www.npmjs.com/package/@modernrelay/omnigraph) or
[Omnigraph Studio](https://www.omnigraph.dev/studio), a desktop app. Agents connect over MCP.

## What you get at install

An **empty cluster**: no graphs, plus one cluster policy that lets the `hola-admin` actor manage
configuration. The server can't boot from an unapplied root, so a one-shot `omnigraph-init` service
applies this cluster on first start. You add graphs, schemas, stored queries and graph policies
yourself with `omnigraph cluster apply`, and they go live without a restart.

The **Admin Token** is generated at install. You can find it later in this app's configuration in
Hola. It authenticates as the `hola-admin` actor.

The image is published for **linux/amd64 only**.

## Connecting the CLI

Install the CLI (`brew install ModernRelay/tap/omnigraph`, or upstream's install script), then
register this server in `~/.omnigraph/config.yaml`:

```yaml
version: 1
targets:
  hola:
    kind: server
    endpoint: https://<app-host>
    auth: {provider: token, source: {env: OMNIGRAPH_TOKEN}}
    default_graph: knowledge
defaults:
  target: hola
```

```sh
export OMNIGRAPH_TOKEN=<admin-token>
```

Use the same major/minor CLI version as the server (0.16 in this bundle). The HTTP contract is
checked on every request.

### Adding a first graph

A bundle directory, for example `my-cluster/`:

```yaml
# cluster.yaml
version: 1
metadata:
  name: hola
graphs:
  knowledge:
    schema: knowledge.pg
    queries: queries/
policies:
  cluster-access:            # keep this one, or hola-admin loses config_manage
    file: cluster.policy.yaml
    applies_to: [cluster]
  graph-access:
    file: graph.policy.yaml
    applies_to: [knowledge]
```

```yaml
# cluster.policy.yaml: the policy this package installs; keep it in your bundle
version: 1
groups:
  admins: [hola-admin]
rules:
  - id: admins-manage-config
    allow:
      actors: { group: admins }
      actions: [config_manage]
  - id: admins-list-graphs
    allow:
      actors: { group: admins }
      actions: [graph_list]
```

```yaml
# graph.policy.yaml: a graph with no policy refuses every action, reads included
version: 1
groups:
  admins: [hola-admin]
rules:
  - id: admins-all
    allow:
      actors: { group: admins }
      actions: [read, export, change, schema_apply, branch_create, branch_delete, branch_merge, invoke_query]
```

```pg
// knowledge.pg
node Person {
  slug: String @key
  name: String
}
```

```gq
// queries/people.gq
query people() {
  match { $p: Person }
  return { $p.name as name }
  order { name asc }
}
```

```sh
omnigraph cluster apply --config ./my-cluster
omnigraph load --data people.jsonl --mode merge
omnigraph query people --format table
```

Each apply replaces the whole declared configuration. A graph you leave out of `cluster.yaml` is
**deleted with its history**, so run `omnigraph cluster plan --config ./my-cluster` first. See
upstream's [cluster guide](https://github.com/ModernRelay/omnigraph/blob/main/docs/user/clusters/index.md)
and [policy guide](https://github.com/ModernRelay/omnigraph/blob/main/docs/user/operations/policy.md).

## Connecting an agent (MCP)

- **URL:** `https://<app-host>/mcp`
- **Header:** `Authorization: Bearer <admin-token>`

Claude Code:

```sh
claude mcp add --transport http omnigraph https://<app-host>/mcp \
  --header "Authorization: Bearer <admin-token>"
```

MCP tools run under the same actor and policy as the HTTP API. A tool can appear in the list and
still be refused. The server refuses MCP requests that carry a browser `Origin` header, so
browser-based MCP clients can't connect. Native clients don't send one.

## How it is packaged

| Service | Image | Role |
| --- | --- | --- |
| `omnigraph` | `modernrelay/omnigraph-server` (Docker Hub) | The server, booted from the cluster root at `${HOLA_APP_DATA}/cluster`. |
| `omnigraph-init` | same image | One-shot. Applies the initial empty cluster if the root has none, then hands the root to the image's non-root user (uid 999). |

`OMNIGRAPH_MCP_ALLOWED_HOSTS` is set to the app's public host. The MCP SDK otherwise refuses the
Host header Traefik forwards.

## Auth

`none`, meaning Hola puts no SSO gate in front. The server enforces its own bearer auth on every
route except `/healthz`, `/readyz` and `/openapi.json`, and it won't start without a credential
source. There is no web page to sign in to, and the CLI, SDK and MCP clients can't complete a
browser SSO login, so a forward-auth gate would block them and protect nothing extra.

Anyone with the Admin Token can change the cluster's configuration, including its policies. Treat
the token like a root password. To rotate it, change *Admin Token* in the app's configuration and
redeploy. The actor stays `hola-admin`, so no policy needs editing.

This package has one token. Upstream supports one token per actor, which lets each actor have its
own policy (for example a read-only agent). This package doesn't expose that yet.

## Backup and restore

`backup@1` and `restore@1`, with no hooks. The snapshot is a file copy of
`${HOLA_APP_DATA}/cluster`, the whole cluster root, which is the unit upstream says to back up.
Omnigraph writes immutable Lance fragments and recovers an interrupted write on its next open the
same way it recovers from a crash. Upstream still tells you to **quiesce writers** before taking a
backup. A copy taken while an agent is writing can catch a write in flight. If you need a
guaranteed-consistent backup, stop the app before the snapshot.

## Upgrades

Take a snapshot before upgrading (`preUpgradeBackup: recommended`). Graph storage format upgrades
(`omnigraph upgrade`) are separate, manual operations with no reverse conversion. Read upstream's
[upgrade guide](https://github.com/ModernRelay/omnigraph/blob/main/docs/user/operations/upgrade.md)
and the [release notes](https://github.com/ModernRelay/omnigraph/releases) before changing the
version.
