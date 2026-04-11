# proxmox-mcp-server

MCP server for managing Proxmox VE infrastructure from any AI assistant.

## Features

- List and monitor nodes, VMs, and containers
- Start, stop, shutdown, reboot, suspend, resume VMs and LXC containers
- Create, clone, delete VMs and containers
- Convert VMs/containers to templates
- View and update configurations (CPU, RAM, disks, network)
- Cloud-init configuration and regeneration
- Execute commands inside VMs via QEMU guest agent
- Manage snapshots (create, delete, rollback)
- Backup VMs and containers
- Firewall rule management
- Migrate VMs/containers between nodes
- RRD metrics (CPU, memory, IO, network) over time
- List ISOs, templates, storage pools, network interfaces
- Multi-host support with fallback URLs
- Input validation and secure API calls

## Setup

### 1. Create a Proxmox API Token

In Proxmox web UI: **Datacenter -> Permissions -> API Tokens -> Add**

- User: a dedicated user like `mcp@pve` with only the permissions you need (see Security section below)
- Token ID: `claude` (or any name)
- Leave "Privilege Separation" checked for least-privilege access

> **Note:** You can use `root@pam` with Privilege Separation unchecked for full access, but this gives the AI assistant complete control over your hypervisor. A dedicated user with limited permissions is strongly recommended.

Copy the token secret -- it's only shown once.

### 2. Configure

Create a `.env` file next to `server.ts`:

#### Single host

```
PROXMOX_HOST=https://your-proxmox-ip:8006
PROXMOX_TOKEN_ID=mcp@pve!claude
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

#### Multi-host

```
PROXMOX_HOSTS=proxmox1=https://192.168.1.41:8006,proxmox2=https://192.168.1.42:8006
PROXMOX_TOKEN_ID_PROXMOX1=mcp@pve!claude
PROXMOX_TOKEN_SECRET_PROXMOX1=uuid-here
PROXMOX_TOKEN_ID_PROXMOX2=mcp@pve!claude
PROXMOX_TOKEN_SECRET_PROXMOX2=uuid-here
PROXMOX_FALLBACK_PROXMOX1=https://fallback-ip:8006  # optional
```

Or set these as environment variables directly.

### 3. Install dependencies

```bash
npm install
```

## Usage with AI Assistants

### Claude Code (CLI)

```bash
claude mcp add --scope user proxmox -- npx tsx /path/to/proxmox-mcp-server/server.ts
```

Or add to `.mcp.json` / Claude settings manually:

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "npx",
      "args": ["tsx", "/path/to/proxmox-mcp-server/server.ts"],
      "env": {
        "PROXMOX_HOST": "https://your-proxmox:8006",
        "PROXMOX_TOKEN_ID": "mcp@pve!claude",
        "PROXMOX_TOKEN_SECRET": "your-secret"
      }
    }
  }
}
```

Note: if the `.env` file is already configured next to `server.ts`, you don't need to pass env vars in the MCP config.

### Cursor / Copilot / Other MCP clients

Same configuration -- any client that supports the MCP stdio transport will work.

## Available Tools (52)

### Discovery & Overview

| Tool | Description |
|------|-------------|
| `list_hosts` | List all configured Proxmox hosts |
| `get_cluster_status` | Cluster overview and node states |
| `list_all_resources` | All resources across cluster (filter by vm/lxc/storage/node) |

### Node Management

| Tool | Description |
|------|-------------|
| `get_node_status` | Node CPU, RAM, disk, uptime |
| `get_node_rrd` | RRD metrics over time (hour/day/week/month/year) |
| `get_node_tasks` | Recent task log |
| `list_storage` | Storage pools with usage stats |
| `list_networks` | Network interfaces/bridges |
| `list_isos` | Available ISO images on a storage |
| `list_templates` | Available container templates on a storage |

### QEMU VMs

| Tool | Description |
|------|-------------|
| `list_vms` | List VMs on a node |
| `get_vm_status` / `get_vm_config` / `get_vm_rrd` | VM info and metrics |
| `start_vm` / `shutdown_vm` / `reboot_vm` | Graceful power control |
| `stop_vm` / `suspend_vm` / `resume_vm` | Force stop, suspend/resume |
| `create_vm` / `clone_vm` / `delete_vm` | Lifecycle management |
| `convert_vm_to_template` | Convert VM to template (irreversible) |
| `update_vm_config` / `resize_vm_disk` | Modify config |
| `set_vm_cloudinit` / `regenerate_cloudinit` | Cloud-init |
| `exec_vm_command` | Execute command via QEMU guest agent |
| `migrate_vm` | Migrate VM to another node |

### LXC Containers

| Tool | Description |
|------|-------------|
| `list_containers` | List containers on a node |
| `get_container_status` / `get_container_config` | Container info |
| `start_container` / `shutdown_container` / `reboot_container` | Graceful power control |
| `stop_container` | Force stop |
| `create_container` / `clone_container` / `delete_container` | Lifecycle management |
| `convert_container_to_template` | Convert to template (irreversible) |
| `update_container_config` / `resize_container_disk` | Modify config |
| `migrate_container` | Migrate container to another node |

### Snapshots & Backups

| Tool | Description |
|------|-------------|
| `list_snapshots` | VM/container snapshots |
| `create_snapshot` / `delete_snapshot` / `rollback_snapshot` | Snapshot management |
| `list_backups` | Backup files on a storage |
| `backup_vm` | Start a backup (snapshot/suspend/stop mode) |

### Firewall

| Tool | Description |
|------|-------------|
| `list_firewall_rules` | List firewall rules for a VM/container |
| `add_firewall_rule` | Add a firewall rule |

## Security

### TLS

TLS certificate verification is **enabled by default**. If your Proxmox uses a self-signed certificate, you have two options:

1. **(Recommended)** Add your Proxmox CA to the system trust store, or set `NODE_EXTRA_CA_CERTS=/path/to/proxmox-ca.pem`
2. Set `PROXMOX_INSECURE=1` to skip TLS verification for Proxmox connections only (not recommended for production)

When `PROXMOX_INSECURE=1` is set, TLS verification is disabled **only for Proxmox API calls** — other HTTPS connections in the process are not affected.

### Read-Only Mode

Set `PROXMOX_READ_ONLY=1` to restrict the server to read-only operations. In this mode:
- Write tools (create, delete, start, stop, exec, etc.) are not listed and are blocked
- Only discovery, status, and monitoring tools are available

This is useful for monitoring dashboards or when you want the AI to inspect but not modify your infrastructure.

### Logging

All tool invocations are logged to stderr with timestamps, tool names, and arguments (secrets are redacted). Errors and read-only blocks are also logged. This provides an audit trail of all AI actions.

### Input Validation

All path parameters (node, vmid, storage, snapname) are validated against injection with strict regex (`^[a-zA-Z0-9._-]+$`).

### Recommended Proxmox Permissions

Instead of `root@pam`, create a dedicated user with minimal permissions:

```bash
# Create user and role in Proxmox
pveum user add mcp@pve
pveum role add MCP-Audit -privs "VM.Audit,Datastore.Audit,Sys.Audit,Pool.Audit"
pveum role add MCP-Operator -privs "VM.Audit,VM.PowerMgmt,VM.Console,Datastore.Audit,Sys.Audit,Pool.Audit"
pveum aclmod / -user mcp@pve -role MCP-Audit    # read-only
# pveum aclmod / -user mcp@pve -role MCP-Operator  # read + power control
```

### Destructive Operations

Destructive operations (delete, stop, rollback, convert-to-template, exec) have explicit warnings in their descriptions to encourage AI assistants to confirm with the user before executing.

## Requirements

- [Node.js](https://nodejs.org) 18+ (uses tsx for TypeScript execution)
- Proxmox VE 7+ with API access
- Network access to Proxmox API (direct, VPN, or Tailscale)
