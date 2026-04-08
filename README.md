# proxmox-mcp-server

MCP server for managing Proxmox VE infrastructure from any AI assistant.

## Features

- List and monitor nodes, VMs, and containers
- Start, stop, shutdown, reboot VMs and LXC containers
- View configurations (CPU, RAM, disks, network)
- Manage snapshots (create, delete, rollback)
- List storage pools and network interfaces
- View task history

## Setup

### 1. Create a Proxmox API Token

In Proxmox web UI: **Datacenter → Permissions → API Tokens → Add**

- User: `root@pam` (or another user with appropriate permissions)
- Token ID: `claude` (or any name)
- Uncheck "Privilege Separation" for full access

Copy the token secret — it's only shown once.

### 2. Configure

Create a `.env` file next to `server.ts`:

```
PROXMOX_HOST=https://your-proxmox-ip:8006
PROXMOX_TOKEN_ID=root@pam!claude
PROXMOX_TOKEN_SECRET=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

Or set these as environment variables.

### 3. Install dependencies

```bash
bun install
```

## Usage with AI Assistants

### Claude Code

Add to your MCP config (`.mcp.json` or Claude settings):

```json
{
  "mcpServers": {
    "proxmox": {
      "command": "bun",
      "args": ["run", "/path/to/proxmox-mcp-server/server.ts"],
      "env": {
        "PROXMOX_HOST": "https://your-proxmox:8006",
        "PROXMOX_TOKEN_ID": "root@pam!claude",
        "PROXMOX_TOKEN_SECRET": "your-secret"
      }
    }
  }
}
```

### Cursor / Copilot / Other MCP clients

Same configuration — any client that supports the MCP stdio transport will work.

## Available Tools

| Tool | Description |
|------|-------------|
| `get_cluster_status` | Cluster overview and node states |
| `list_all_resources` | All resources across cluster |
| `get_node_status` | Node CPU, RAM, disk, uptime |
| `list_vms` | QEMU VMs on a node |
| `list_containers` | LXC containers on a node |
| `get_vm_status` | Detailed VM status |
| `get_container_status` | Detailed container status |
| `start_vm` / `stop_vm` / `shutdown_vm` / `reboot_vm` | VM power control |
| `start_container` / `stop_container` / `shutdown_container` | Container power control |
| `get_vm_config` | VM configuration |
| `get_container_config` | Container configuration |
| `list_snapshots` | VM/container snapshots |
| `create_snapshot` / `delete_snapshot` / `rollback_snapshot` | Snapshot management |
| `list_storage` | Storage pools |
| `list_networks` | Network interfaces |
| `get_node_tasks` | Recent task log |

## Requirements

- [Bun](https://bun.sh) runtime
- Proxmox VE 7+ with API access
- Network access to Proxmox API (direct, VPN, or Tailscale)
