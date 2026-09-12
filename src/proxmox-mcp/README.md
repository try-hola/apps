# proxmox-mcp

[ProxmoxMCP-Plus](https://github.com/RekklesNA/ProxmoxMCP-Plus) — an MCP server for
Proxmox VE (nodes, VMs, containers, snapshots, backups, task logs) — packaged for Hola
so an AI agent can manage your hypervisor through one authenticated endpoint.

## Layout (Hola app package format)

```
src/proxmox-mcp/
├── package.json        # name + version + OCI annotations
└── src/
    ├── compose.yaml    # one service, MCP Streamable HTTP mode, no host ports
    └── manifest.json   # Hola defaults (ingress port, wizard fields, auth)
```

## How it is exposed

- **Endpoint:** `https://proxmox-mcp.<HOLA_BASE_DOMAIN>/mcp` (MCP Streamable HTTP).
  Traefik is the only ingress; the container publishes no host port.
- **Auth:** the manifest declares `forward-auth` with `bypassPaths: ["/mcp"]` — the same
  pattern `remo` uses for its setup API. `/mcp` is exempted from the interactive Authentik
  login because the app protects it with its **own** bearer credential (`MCP_API_KEY`,
  generated at install); everything else on the host stays behind SSO. MCP clients are not
  browsers, so a cookie-based forward-auth gate would only lock them out.
- **Client config:** point your MCP client at the URL above with
  `Authorization: Bearer <MCP_API_KEY>`; the key is on the deployment's configuration tab.

## What it can do — and the blast radius

This app hands whoever holds `MCP_API_KEY` control of your hypervisor, so it ships
defensively:

- `MCP_TOOL_DENYLIST` defaults to `delete_vm,delete_container,delete_snapshot,rollback_snapshot`.
  Clear it in the wizard (advanced) to expose everything.
- Guest command execution (`execute_vm_command`, `execute_container_command`) is gated
  by the server's command policy, which defaults to deny-all
  ([upstream docs](https://github.com/RekklesNA/ProxmoxMCP-Plus/blob/main/docs/container-command-execution.md)).
  Two advanced wizard fields expose it: `COMMAND_POLICY_MODE` (`deny_all` | `allowlist` |
  `audit_only`) and `COMMAND_POLICY_ALLOW_PATTERNS` (comma-separated regexes). An
  agent that provisions VMs typically needs exactly one allowlisted command — appending
  an SSH key to a freshly cloned guest's `authorized_keys` — since the MCP tool set can
  clone, start, stop, snapshot and delete VMs but has no tool to write cloud-init
  settings (`sshkeys`, `ciuser`, `ipconfig0`) on the clone.
- Use a **dedicated Proxmox user + API token** with only the ACLs the exposed tools need
  (`PVEAuditor` for read-only use; add `PVEVMAdmin` on the pools you want managed).
  Do not point it at `root@pam`.
- DNS-rebinding protection is on, allowing only the public host Traefik serves.

## Configuration

**Self-signed Proxmox certificate?** Turn *Verify Proxmox TLS certificate* off **and**
*Allow unverified TLS (dev mode)* on. The upstream server refuses to start with
verification off unless its dev-mode flag is set (verified: the container exits with
"Insecure TLS configuration blocked" otherwise). Dev mode gates only that check.

All settings are wizard fields (`manifest.defaultEnv`): the Proxmox host, API user,
token name and secret are required; the MCP key is generated; port, TLS verification
and the tool denylist are advanced. The image's `PROXMOX_MCP_CONFIG` file is never
mounted, so the server reads exactly these environment variables.

## State

None worth keeping: the optional job store is an SQLite file inside the container's
own working directory and is recreated on restart. No data volume, so nothing to back
up (`accepts` is intentionally empty).

## Pre-release: fork image

Version `0.1.0-beta.1` (channel `beta`) runs the image built from the
[pofallon/ProxmoxMCP-Plus](https://github.com/pofallon/ProxmoxMCP-Plus) fork at
`v0.5.15-hola.1`: upstream v0.5.15 plus the VM provisioning tools proposed upstream in
[RekklesNA/ProxmoxMCP-Plus#127](https://github.com/RekklesNA/ProxmoxMCP-Plus/pull/127)
(`update_vm_config`, `get_vm_ip_addresses`, `get_next_vmid`), which an agent needs to take a
cloud-init template clone to a reachable guest. The stable version returns to the upstream
image once a release includes them.

## Aggregation (later)

Hola's planned aggregated MCP gateway (try-hola/hola spec 002) will front every
MCP-capable app behind one endpoint with Authentik OAuth. This package already speaks
the transport that gateway requires, so joining it will be a manifest `mcp` block, not a
repackage.
