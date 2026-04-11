#!/usr/bin/env node
/**
 * Proxmox VE MCP Server
 *
 * A Model Context Protocol server for managing Proxmox VE infrastructure.
 * Works with any MCP-compatible AI assistant (Claude Code, Cursor, Copilot, etc.)
 *
 * Supports single-host or multi-host configuration.
 *
 * Single host:
 *   PROXMOX_HOST=https://192.168.1.41:8006
 *   PROXMOX_TOKEN_ID=user@realm!tokenname
 *   PROXMOX_TOKEN_SECRET=uuid
 *
 * Multi-host:
 *   PROXMOX_HOSTS=proxmox1=https://192.168.1.41:8006,proxmox2=https://192.168.1.42:8006
 *   PROXMOX_TOKEN_ID_PROXMOX1=user@realm!token
 *   PROXMOX_TOKEN_SECRET_PROXMOX1=uuid
 *   PROXMOX_TOKEN_ID_PROXMOX2=user@realm!token
 *   PROXMOX_TOKEN_SECRET_PROXMOX2=uuid
 *   PROXMOX_FALLBACK_PROXMOX1=https://lan-ip:8006   (optional)
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { Agent as HttpsAgent } from 'node:https'
import { request as httpsRequest } from 'node:https'
import { request as httpRequest } from 'node:http'

// ── Load .env if present ────────────────────────────────────────────────────

function loadEnv() {
  const locations = [
    join(dirname(new URL(import.meta.url).pathname), '.env'),
    join(process.cwd(), '.env'),
  ]
  for (const path of locations) {
    try {
      for (const line of readFileSync(path, 'utf8').split('\n')) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.startsWith('#')) continue
        const m = trimmed.match(/^([A-Za-z_][A-Za-z_0-9]*)=(.*)$/)
        if (!m) continue
        let val = m[2].trim()
        // Quoted values: strip quotes, preserve content as-is (including # characters)
        if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
          val = val.slice(1, -1)
        } else {
          // Unquoted: strip inline comments
          const commentIdx = val.indexOf(' #')
          if (commentIdx !== -1) val = val.slice(0, commentIdx).trim()
        }
        if (process.env[m[1]] === undefined) process.env[m[1]] = val
      }
      break
    } catch {}
  }
}

loadEnv()

// ── Host configuration ──────────────────────────────────────────────────────

interface PveHost {
  name: string
  url: string
  fallbackUrl?: string
  tokenId: string
  tokenSecret: string
}

const hosts: PveHost[] = []

if (process.env.PROXMOX_HOSTS) {
  for (const entry of process.env.PROXMOX_HOSTS.split(',')) {
    const [name, url] = entry.split('=')
    const key = name.toUpperCase()
    const tokenId = process.env[`PROXMOX_TOKEN_ID_${key}`]
    const tokenSecret = process.env[`PROXMOX_TOKEN_SECRET_${key}`]
    if (!tokenId || !tokenSecret) {
      process.stderr.write(`proxmox-mcp-server: missing token for host ${name}\n`)
      process.exit(1)
    }
    const fallbackUrl = process.env[`PROXMOX_FALLBACK_${key}`]
    hosts.push({ name, url, fallbackUrl, tokenId, tokenSecret })
  }
} else if (process.env.PROXMOX_HOST) {
  const tokenId = process.env.PROXMOX_TOKEN_ID
  const tokenSecret = process.env.PROXMOX_TOKEN_SECRET
  if (!tokenId || !tokenSecret) {
    process.stderr.write(
      `proxmox-mcp-server: missing configuration\n\n` +
      `Set env vars or create a .env file:\n` +
      `  PROXMOX_HOST=https://your-proxmox:8006\n` +
      `  PROXMOX_TOKEN_ID=user@realm!tokenname\n` +
      `  PROXMOX_TOKEN_SECRET=uuid\n`,
    )
    process.exit(1)
  }
  hosts.push({ name: 'default', url: process.env.PROXMOX_HOST, fallbackUrl: process.env.PROXMOX_FALLBACK, tokenId, tokenSecret })
} else {
  process.stderr.write(`proxmox-mcp-server: no hosts configured. Set PROXMOX_HOST or PROXMOX_HOSTS.\n`)
  process.exit(1)
}

const hostNames = hosts.map(h => h.name)
const isMultiHost = hosts.length > 1

function getHost(name?: string): PveHost {
  if (!name || !isMultiHost) return hosts[0]
  const h = hosts.find(h => h.name === name)
  if (!h) throw new Error(`Unknown host "${name}". Available: ${hostNames.join(', ')}`)
  return h
}

// ── TLS configuration (scoped to Proxmox connections only) ─────────────────

const insecureAgent = process.env.PROXMOX_INSECURE === '1'
  ? new HttpsAgent({ rejectUnauthorized: false })
  : undefined

if (insecureAgent) {
  process.stderr.write('proxmox-mcp-server: TLS verification disabled for Proxmox connections (PROXMOX_INSECURE=1)\n')
}

// ── Read-only mode ─────────────────────────────────────────────────────────

const readOnly = process.env.PROXMOX_READ_ONLY === '1'

const WRITE_TOOLS = new Set([
  'start_vm', 'stop_vm', 'shutdown_vm', 'reboot_vm', 'suspend_vm', 'resume_vm',
  'create_vm', 'clone_vm', 'delete_vm', 'convert_vm_to_template',
  'update_vm_config', 'resize_vm_disk',
  'set_vm_cloudinit', 'regenerate_cloudinit',
  'exec_vm_command',
  'migrate_vm',
  'start_container', 'stop_container', 'shutdown_container', 'reboot_container',
  'create_container', 'clone_container', 'delete_container', 'convert_container_to_template',
  'update_container_config', 'resize_container_disk', 'migrate_container',
  'create_snapshot', 'delete_snapshot', 'rollback_snapshot',
  'backup_vm',
  'add_firewall_rule',
])

// ── Proxmox API client ──────────────────────────────────────────────────────

function pveRequest(urlStr: string, method: string, headers: Record<string, string>, bodyStr?: string): Promise<{ ok: boolean; status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(urlStr)
    const isHttps = parsed.protocol === 'https:'
    const reqFn = isHttps ? httpsRequest : httpRequest
    const options: Record<string, unknown> = {
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method,
      headers,
      timeout: 10000,
    }
    if (isHttps && insecureAgent) {
      options.agent = insecureAgent
    }

    const req = reqFn(options as never, (res) => {
      const chunks: Buffer[] = []
      res.on('data', (chunk: Buffer) => chunks.push(chunk))
      res.on('end', () => {
        resolve({ ok: res.statusCode! >= 200 && res.statusCode! < 300, status: res.statusCode!, body: Buffer.concat(chunks).toString() })
      })
    })

    req.on('error', reject)
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')) })

    if (bodyStr) req.write(bodyStr)
    req.end()
  })
}

async function pveApiFetch(baseUrl: string, host: PveHost, method: string, path: string, body?: Record<string, unknown>): Promise<{ ok: boolean; data: unknown; status: number; raw?: string }> {
  const url = `${baseUrl}/api2/json${path}`
  const headers: Record<string, string> = {
    'Authorization': `PVEAPIToken=${host.tokenId}=${host.tokenSecret}`,
  }

  let bodyStr: string | undefined
  if (body && method !== 'GET') {
    headers['Content-Type'] = 'application/x-www-form-urlencoded'
    bodyStr = new URLSearchParams(
      Object.entries(body).filter(([, v]) => v !== undefined && v !== null).map(([k, v]) => [k, String(v)])
    ).toString()
  }

  const res = await pveRequest(url, method, headers, bodyStr)
  const json = JSON.parse(res.body) as { data?: unknown; errors?: unknown }
  return { ok: res.ok, data: json.data, status: res.status, raw: JSON.stringify(json.errors ?? json) }
}

async function pveApi(host: PveHost, method: string, path: string, body?: Record<string, unknown>): Promise<unknown> {
  let primaryError: Error | undefined
  try {
    const res = await pveApiFetch(host.url, host, method, path, body)
    if (res.ok) return res.data
    // Auth errors are never retried on fallback
    if (res.status === 401 || res.status === 403) {
      throw new Error(`Proxmox API ${res.status} on ${host.name}: ${res.raw}`)
    }
    primaryError = new Error(`Proxmox API ${res.status} on ${host.name}: ${res.raw}`)
  } catch (err: unknown) {
    if (err instanceof Error && (err.message.includes('401') || err.message.includes('403'))) throw err
    primaryError = err instanceof Error ? err : new Error(String(err))
  }

  if (host.fallbackUrl) {
    process.stderr.write(`proxmox-mcp-server: primary URL failed for ${host.name}, trying fallback...\n`)
    const res = await pveApiFetch(host.fallbackUrl, host, method, path, body)
    if (res.ok) return res.data
    throw new Error(`Proxmox API ${res.status} on ${host.name} (fallback): ${res.raw}`)
  }

  throw primaryError ?? new Error(`Proxmox API: all URLs failed for ${host.name}`)
}

async function pveGet(host: PveHost, path: string) { return pveApi(host, 'GET', path) }
async function pvePost(host: PveHost, path: string, body?: Record<string, unknown>) { return pveApi(host, 'POST', path, body) }
async function pvePut(host: PveHost, path: string, body?: Record<string, unknown>) { return pveApi(host, 'PUT', path, body) }
async function pveDelete(host: PveHost, path: string) { return pveApi(host, 'DELETE', path) }

// ── Input validation ───────────────────────────────────────────────────────

function validateIdentifier(value: unknown, label: string): string {
  const s = String(value)
  if (!/^[a-zA-Z0-9._-]+$/.test(s)) throw new Error(`Invalid ${label}: "${s}" — only alphanumeric, dots, hyphens, underscores allowed`)
  return s
}

function validateVmid(value: unknown): number {
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1 || n > 999999999) throw new Error(`Invalid vmid: ${value}`)
  return n
}

const VALID_VM_TYPES = new Set(['qemu', 'lxc'])
function validateVmType(value: unknown): string {
  const s = String(value || 'qemu')
  if (!VALID_VM_TYPES.has(s)) throw new Error(`Invalid type: "${s}" — must be qemu or lxc`)
  return s
}

const VALID_TIMEFRAMES = new Set(['hour', 'day', 'week', 'month', 'year'])
function validateTimeframe(value: unknown): string {
  const s = String(value || 'hour')
  if (!VALID_TIMEFRAMES.has(s)) throw new Error(`Invalid timeframe: "${s}"`)
  return s
}

function validatePositiveInt(value: unknown, label: string, fallback: number): number {
  if (value == null) return fallback
  const n = Number(value)
  if (!Number.isInteger(n) || n < 1) throw new Error(`Invalid ${label}: ${value}`)
  return n
}

// ── Schema helpers ──────────────────────────────────────────────────────────

const hostParam = isMultiHost
  ? { host: { type: 'string' as const, enum: hostNames, description: `Proxmox host (${hostNames.join(', ')})` } }
  : {}
const hostRequired = isMultiHost ? ['host'] : []

function nodeSchema(extra: Record<string, unknown> = {}, extraRequired: string[] = []) {
  return {
    type: 'object' as const,
    properties: { ...hostParam, node: { type: 'string', description: 'Node name' }, ...extra },
    required: [...hostRequired, 'node', ...extraRequired],
  }
}

function vmSchema(extra: Record<string, unknown> = {}, extraRequired: string[] = []) {
  return {
    type: 'object' as const,
    properties: { ...hostParam, node: { type: 'string', description: 'Node name' }, vmid: { type: 'number', description: 'VM ID' }, ...extra },
    required: [...hostRequired, 'node', 'vmid', ...extraRequired],
  }
}

function ctSchema(extra: Record<string, unknown> = {}, extraRequired: string[] = []) {
  return {
    type: 'object' as const,
    properties: { ...hostParam, node: { type: 'string', description: 'Node name' }, vmid: { type: 'number', description: 'Container ID' }, ...extra },
    required: [...hostRequired, 'node', 'vmid', ...extraRequired],
  }
}

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS = [
  // ─── Discovery & Overview ───
  { name: 'list_hosts', description: 'List all configured Proxmox hosts', inputSchema: { type: 'object' as const, properties: {} } },
  { name: 'get_cluster_status', description: 'Get cluster status — nodes online/offline', inputSchema: { type: 'object' as const, properties: { ...hostParam }, required: [...hostRequired] } },
  {
    name: 'list_all_resources',
    description: 'List all resources across the cluster (VMs, containers, storage, nodes)',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, type: { type: 'string', enum: ['vm', 'lxc', 'storage', 'node'], description: 'Filter by type (optional)' } }, required: [...hostRequired] },
  },

  // ─── Node ───
  { name: 'get_node_status', description: 'Get CPU, RAM, disk, uptime for a node', inputSchema: nodeSchema() },
  { name: 'list_storage', description: 'List storage pools on a node with usage stats', inputSchema: nodeSchema() },
  { name: 'list_networks', description: 'List network interfaces/bridges on a node', inputSchema: nodeSchema() },
  { name: 'get_node_tasks', description: 'Get recent tasks log for a node', inputSchema: nodeSchema({ limit: { type: 'number', description: 'Max tasks (default: 20)' } }) },
  {
    name: 'get_node_rrd',
    description: 'Get RRD metrics (CPU, memory, IO, network) for a node over time',
    inputSchema: nodeSchema({ timeframe: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year'], description: 'Time range (default: hour)' } }),
  },
  {
    name: 'list_isos',
    description: 'List available ISO images on a storage',
    inputSchema: nodeSchema({ storage: { type: 'string', description: 'Storage name (e.g. local)' } }, ['storage']),
  },
  {
    name: 'list_templates',
    description: 'List available container templates on a storage',
    inputSchema: nodeSchema({ storage: { type: 'string', description: 'Storage name' } }, ['storage']),
  },

  // ─── VM (QEMU) — Read ───
  { name: 'list_vms', description: 'List all QEMU VMs on a node', inputSchema: nodeSchema() },
  { name: 'get_vm_status', description: 'Get detailed status of a VM', inputSchema: vmSchema() },
  { name: 'get_vm_config', description: 'Get full config of a VM (CPU, RAM, disks, network)', inputSchema: vmSchema() },
  {
    name: 'get_vm_rrd',
    description: 'Get RRD metrics for a VM over time',
    inputSchema: vmSchema({ timeframe: { type: 'string', enum: ['hour', 'day', 'week', 'month', 'year'], description: 'Time range (default: hour)' } }),
  },

  // ─── VM (QEMU) — Power ───
  { name: 'start_vm', description: 'Start a VM', inputSchema: vmSchema() },
  { name: 'stop_vm', description: '⚠️ DESTRUCTIVE: Force stop a VM (like pulling the power cord) — may cause data loss. Prefer shutdown_vm for graceful stop.', inputSchema: vmSchema() },
  { name: 'shutdown_vm', description: 'Gracefully shutdown a VM via ACPI', inputSchema: vmSchema() },
  { name: 'reboot_vm', description: 'Reboot a VM', inputSchema: vmSchema() },
  { name: 'suspend_vm', description: 'Suspend a VM to RAM', inputSchema: vmSchema() },
  { name: 'resume_vm', description: 'Resume a suspended VM', inputSchema: vmSchema() },

  // ─── VM (QEMU) — Create / Clone / Delete ───
  {
    name: 'create_vm',
    description: 'Create a new QEMU VM. Minimal: just vmid + node. Add iso, disk, net etc. as needed.',
    inputSchema: vmSchema({
      name: { type: 'string', description: 'VM name' },
      memory: { type: 'number', description: 'RAM in MB (default: 2048)' },
      cores: { type: 'number', description: 'CPU cores (default: 1)' },
      sockets: { type: 'number', description: 'CPU sockets (default: 1)' },
      cpu: { type: 'string', description: 'CPU type (default: host)' },
      ostype: { type: 'string', enum: ['l26', 'l24', 'win11', 'win10', 'win7', 'other'], description: 'OS type (default: l26 = Linux 2.6+)' },
      ide2: { type: 'string', description: 'CD-ROM, e.g. local:iso/ubuntu.iso,media=cdrom' },
      scsi0: { type: 'string', description: 'Main disk, e.g. local-lvm:32 (32GB)' },
      scsihw: { type: 'string', description: 'SCSI controller (default: virtio-scsi-single)' },
      net0: { type: 'string', description: 'Network, e.g. virtio,bridge=vmbr0' },
      bios: { type: 'string', enum: ['seabios', 'ovmf'], description: 'BIOS type (default: seabios)' },
      efidisk0: { type: 'string', description: 'EFI disk for OVMF, e.g. local-lvm:1' },
      boot: { type: 'string', description: 'Boot order, e.g. order=scsi0;ide2;net0' },
      agent: { type: 'string', description: 'QEMU agent, e.g. 1 to enable' },
      start: { type: 'boolean', description: 'Start after creation (default: false)' },
    }),
  },
  {
    name: 'clone_vm',
    description: 'Clone a VM (full or linked clone). Use this to deploy from templates.',
    inputSchema: vmSchema({
      newid: { type: 'number', description: 'New VM ID for the clone' },
      name: { type: 'string', description: 'Name for the clone' },
      full: { type: 'boolean', description: 'Full clone (true) or linked clone (false, default)' },
      target: { type: 'string', description: 'Target node for the clone (optional, for migration)' },
      storage: { type: 'string', description: 'Target storage for full clone (optional)' },
      description: { type: 'string', description: 'Description for the clone' },
    }, ['newid']),
  },
  {
    name: 'delete_vm',
    description: '⚠️ DESTRUCTIVE & IRREVERSIBLE: Delete/destroy a VM and ALL its data (disks, config). VM must be stopped first. Always confirm with the user before calling this.',
    inputSchema: vmSchema({
      purge: { type: 'boolean', description: 'Also remove from replication and backup jobs (default: false)' },
      'destroy-unreferenced-disks': { type: 'boolean', description: 'Delete unreferenced disks (default: true)' },
    }),
  },
  {
    name: 'convert_vm_to_template',
    description: '⚠️ IRREVERSIBLE: Convert a VM into a template — cannot be undone. VM must be stopped. Confirm with user first.',
    inputSchema: vmSchema(),
  },

  // ─── VM (QEMU) — Modify Config ───
  {
    name: 'update_vm_config',
    description: 'Update VM configuration (CPU, RAM, disks, network, etc.). Pass any PVE config key.',
    inputSchema: vmSchema({
      memory: { type: 'number', description: 'RAM in MB' },
      cores: { type: 'number', description: 'CPU cores' },
      sockets: { type: 'number', description: 'CPU sockets' },
      cpu: { type: 'string', description: 'CPU type' },
      name: { type: 'string', description: 'VM name' },
      net0: { type: 'string', description: 'Network config' },
      scsi0: { type: 'string', description: 'Disk config' },
      ide2: { type: 'string', description: 'CD-ROM config' },
      boot: { type: 'string', description: 'Boot order' },
      agent: { type: 'string', description: 'QEMU agent config' },
      description: { type: 'string', description: 'VM description' },
      onboot: { type: 'boolean', description: 'Start on boot' },
      tags: { type: 'string', description: 'Tags (semicolon-separated)' },
      delete: { type: 'string', description: 'Comma-separated list of settings to delete' },
    }),
  },
  {
    name: 'resize_vm_disk',
    description: 'Resize (grow) a VM disk',
    inputSchema: vmSchema({
      disk: { type: 'string', description: 'Disk name (e.g. scsi0, virtio0)' },
      size: { type: 'string', description: 'New size or increment (e.g. +10G, 50G)' },
    }, ['disk', 'size']),
  },

  // ─── VM (QEMU) — Cloud-Init ───
  {
    name: 'set_vm_cloudinit',
    description: 'Configure cloud-init settings on a VM (user, password, SSH keys, network, etc.)',
    inputSchema: vmSchema({
      ciuser: { type: 'string', description: 'Cloud-init default user' },
      cipassword: { type: 'string', description: 'Cloud-init password' },
      sshkeys: { type: 'string', description: 'SSH public keys (URL-encoded, newline-separated)' },
      ipconfig0: { type: 'string', description: 'IP config for net0, e.g. ip=dhcp or ip=10.0.0.2/24,gw=10.0.0.1' },
      ipconfig1: { type: 'string', description: 'IP config for net1' },
      nameserver: { type: 'string', description: 'DNS nameserver' },
      searchdomain: { type: 'string', description: 'DNS search domain' },
      citype: { type: 'string', enum: ['configdrive2', 'nocloud', 'opennebula'], description: 'Cloud-init type (default: nocloud)' },
    }),
  },
  {
    name: 'regenerate_cloudinit',
    description: 'Regenerate the cloud-init disk image after config changes',
    inputSchema: vmSchema(),
  },

  // ─── VM (QEMU) — Exec via QEMU Agent ───
  {
    name: 'exec_vm_command',
    description: 'Execute a command inside a running VM via QEMU guest agent. Agent must be installed and enabled.',
    inputSchema: vmSchema({
      command: { type: 'string', description: 'Command to execute (e.g. "ls /tmp")' },
    }, ['command']),
  },

  // ─── VM (QEMU) — Migration ───
  {
    name: 'migrate_vm',
    description: 'Migrate a VM to another node',
    inputSchema: vmSchema({
      target: { type: 'string', description: 'Target node name' },
      online: { type: 'boolean', description: 'Online/live migration (default: false)' },
    }, ['target']),
  },

  // ─── Container (LXC) — Read ───
  { name: 'list_containers', description: 'List all LXC containers on a node', inputSchema: nodeSchema() },
  { name: 'get_container_status', description: 'Get detailed status of a container', inputSchema: ctSchema() },
  { name: 'get_container_config', description: 'Get full config of a container', inputSchema: ctSchema() },

  // ─── Container (LXC) — Power ───
  { name: 'start_container', description: 'Start a container', inputSchema: ctSchema() },
  { name: 'stop_container', description: '⚠️ DESTRUCTIVE: Force stop a container — may cause data loss. Prefer shutdown_container.', inputSchema: ctSchema() },
  { name: 'shutdown_container', description: 'Gracefully shutdown a container', inputSchema: ctSchema() },
  { name: 'reboot_container', description: 'Reboot a container', inputSchema: ctSchema() },

  // ─── Container (LXC) — Create / Clone / Delete ───
  {
    name: 'create_container',
    description: 'Create a new LXC container from a template',
    inputSchema: ctSchema({
      ostemplate: { type: 'string', description: 'Template, e.g. local:vztmpl/ubuntu-22.04-standard_22.04-1_amd64.tar.zst' },
      hostname: { type: 'string', description: 'Container hostname' },
      memory: { type: 'number', description: 'RAM in MB (default: 512)' },
      swap: { type: 'number', description: 'Swap in MB (default: 512)' },
      cores: { type: 'number', description: 'CPU cores (default: 1)' },
      rootfs: { type: 'string', description: 'Root filesystem, e.g. local-lvm:8 (8GB)' },
      net0: { type: 'string', description: 'Network, e.g. name=eth0,bridge=vmbr0,ip=dhcp' },
      password: { type: 'string', description: 'Root password' },
      'ssh-public-keys': { type: 'string', description: 'SSH public keys' },
      unprivileged: { type: 'boolean', description: 'Unprivileged container (default: true)' },
      start: { type: 'boolean', description: 'Start after creation' },
      onboot: { type: 'boolean', description: 'Start on boot' },
      nameserver: { type: 'string', description: 'DNS nameserver' },
      searchdomain: { type: 'string', description: 'DNS search domain' },
      features: { type: 'string', description: 'Features, e.g. nesting=1' },
    }, ['ostemplate']),
  },
  {
    name: 'clone_container',
    description: 'Clone an LXC container',
    inputSchema: ctSchema({
      newid: { type: 'number', description: 'New container ID' },
      hostname: { type: 'string', description: 'Hostname for the clone' },
      full: { type: 'boolean', description: 'Full clone (default: false = linked)' },
      storage: { type: 'string', description: 'Target storage' },
      target: { type: 'string', description: 'Target node' },
    }, ['newid']),
  },
  {
    name: 'delete_container',
    description: '⚠️ DESTRUCTIVE & IRREVERSIBLE: Delete/destroy a container and ALL its data. Must be stopped first. Always confirm with the user.',
    inputSchema: ctSchema({
      purge: { type: 'boolean', description: 'Remove from backup/replication jobs' },
      force: { type: 'boolean', description: 'Force destroy even if running' },
    }),
  },
  {
    name: 'convert_container_to_template',
    description: '⚠️ IRREVERSIBLE: Convert a container into a template — cannot be undone. Confirm with user first.',
    inputSchema: ctSchema(),
  },

  // ─── Container (LXC) — Modify Config ───
  {
    name: 'update_container_config',
    description: 'Update container configuration',
    inputSchema: ctSchema({
      hostname: { type: 'string', description: 'Hostname' },
      memory: { type: 'number', description: 'RAM in MB' },
      swap: { type: 'number', description: 'Swap in MB' },
      cores: { type: 'number', description: 'CPU cores' },
      net0: { type: 'string', description: 'Network config' },
      rootfs: { type: 'string', description: 'Root filesystem' },
      nameserver: { type: 'string', description: 'DNS' },
      description: { type: 'string', description: 'Description' },
      onboot: { type: 'boolean', description: 'Start on boot' },
      tags: { type: 'string', description: 'Tags' },
      features: { type: 'string', description: 'Features (e.g. nesting=1)' },
      delete: { type: 'string', description: 'Settings to delete (comma-separated)' },
    }),
  },
  {
    name: 'resize_container_disk',
    description: 'Resize a container disk',
    inputSchema: ctSchema({
      disk: { type: 'string', description: 'Disk name (e.g. rootfs, mp0)' },
      size: { type: 'string', description: 'New size or increment (e.g. +5G, 20G)' },
    }, ['disk', 'size']),
  },
  {
    name: 'migrate_container',
    description: 'Migrate a container to another node',
    inputSchema: ctSchema({
      target: { type: 'string', description: 'Target node' },
      restart: { type: 'boolean', description: 'Restart after migration (for running containers)' },
    }, ['target']),
  },

  // ─── Snapshots (VM + LXC) ───
  {
    name: 'list_snapshots',
    description: 'List snapshots of a VM or container',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, node: { type: 'string', description: 'Node name' }, vmid: { type: 'number', description: 'VM/Container ID' }, type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Type (default: qemu)' } }, required: [...hostRequired, 'node', 'vmid'] },
  },
  {
    name: 'create_snapshot',
    description: 'Create a snapshot',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, node: { type: 'string', description: 'Node' }, vmid: { type: 'number', description: 'ID' }, type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Type (default: qemu)' }, snapname: { type: 'string', description: 'Snapshot name' }, description: { type: 'string', description: 'Description' } }, required: [...hostRequired, 'node', 'vmid', 'snapname'] },
  },
  {
    name: 'delete_snapshot',
    description: 'Delete a snapshot',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, node: { type: 'string', description: 'Node' }, vmid: { type: 'number', description: 'ID' }, type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Type (default: qemu)' }, snapname: { type: 'string', description: 'Snapshot name' } }, required: [...hostRequired, 'node', 'vmid', 'snapname'] },
  },
  {
    name: 'rollback_snapshot',
    description: '⚠️ DESTRUCTIVE: Rollback to a snapshot — all changes since the snapshot will be lost. Confirm with user first.',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, node: { type: 'string', description: 'Node' }, vmid: { type: 'number', description: 'ID' }, type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Type (default: qemu)' }, snapname: { type: 'string', description: 'Snapshot name' } }, required: [...hostRequired, 'node', 'vmid', 'snapname'] },
  },

  // ─── Backups ───
  {
    name: 'list_backups',
    description: 'List backup files on a storage',
    inputSchema: nodeSchema({ storage: { type: 'string', description: 'Backup storage name' }, vmid: { type: 'number', description: 'Filter by VM/CT ID (optional)' } }, ['storage']),
  },
  {
    name: 'backup_vm',
    description: 'Start a backup of a VM or container',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, node: { type: 'string', description: 'Node' }, vmid: { type: 'number', description: 'VM/CT ID' }, storage: { type: 'string', description: 'Backup storage' }, mode: { type: 'string', enum: ['snapshot', 'suspend', 'stop'], description: 'Backup mode (default: snapshot)' }, compress: { type: 'string', enum: ['0', 'gzip', 'lzo', 'zstd'], description: 'Compression (default: zstd)' }, notes: { type: 'string', description: 'Backup notes' } }, required: [...hostRequired, 'node', 'vmid'] },
  },

  // ─── Firewall ───
  {
    name: 'list_firewall_rules',
    description: 'List firewall rules for a VM or container',
    inputSchema: { type: 'object' as const, properties: { ...hostParam, node: { type: 'string', description: 'Node' }, vmid: { type: 'number', description: 'VM/CT ID' }, type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Type (default: qemu)' } }, required: [...hostRequired, 'node', 'vmid'] },
  },
  {
    name: 'add_firewall_rule',
    description: 'Add a firewall rule to a VM or container',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ...hostParam,
        node: { type: 'string', description: 'Node' },
        vmid: { type: 'number', description: 'VM/CT ID' },
        type: { type: 'string', enum: ['qemu', 'lxc'], description: 'Type (default: qemu)' },
        action: { type: 'string', enum: ['ACCEPT', 'DROP', 'REJECT'], description: 'Rule action' },
        direction: { type: 'string', enum: ['in', 'out'], description: 'Traffic direction' },
        enable: { type: 'number', description: '1 to enable, 0 to disable' },
        source: { type: 'string', description: 'Source IP/CIDR' },
        dest: { type: 'string', description: 'Destination IP/CIDR' },
        sport: { type: 'string', description: 'Source port' },
        dport: { type: 'string', description: 'Destination port' },
        proto: { type: 'string', description: 'Protocol (tcp, udp, icmp, etc.)' },
        comment: { type: 'string', description: 'Rule comment' },
      },
      required: [...hostRequired, 'node', 'vmid', 'action', 'direction'],
    },
  },
]

// ── Tool dispatcher ─────────────────────────────────────────────────────────

async function handleTool(name: string, args: Record<string, unknown>): Promise<string> {
  if (name === 'list_hosts') {
    return JSON.stringify(hosts.map(h => ({ name: h.name, url: h.url, fallback: h.fallbackUrl ?? null })), null, 2)
  }

  const host = getHost(args.host as string | undefined)
  const node = args.node != null ? validateIdentifier(args.node, 'node') : undefined
  const vmid = args.vmid != null ? validateVmid(args.vmid) : undefined
  const vmType = validateVmType(args.type)
  const j = (d: unknown) => JSON.stringify(d, null, 2)

  // Collect arbitrary body params (exclude meta keys)
  const metaKeys = new Set(['host', 'node', 'vmid', 'type'])
  function bodyFrom(args: Record<string, unknown>, exclude: string[] = []): Record<string, unknown> {
    const ex = new Set([...metaKeys, ...exclude])
    const body: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(args)) {
      if (!ex.has(k) && v !== undefined && v !== null) body[k] = v
    }
    return body
  }

  switch (name) {
    // ─── Discovery ───
    case 'get_cluster_status': return j(await pveGet(host, '/cluster/status'))
    case 'list_all_resources': {
      const t = args.type ? `?type=${validateIdentifier(args.type, 'type')}` : ''
      return j(await pveGet(host, `/cluster/resources${t}`))
    }

    // ─── Node ───
    case 'get_node_status': return j(await pveGet(host, `/nodes/${node}/status`))
    case 'list_storage': return j(await pveGet(host, `/nodes/${node}/storage`))
    case 'list_networks': return j(await pveGet(host, `/nodes/${node}/network`))
    case 'get_node_tasks': return j(await pveGet(host, `/nodes/${node}/tasks?limit=${validatePositiveInt(args.limit, 'limit', 20)}`))
    case 'get_node_rrd': return j(await pveGet(host, `/nodes/${node}/rrddata?timeframe=${validateTimeframe(args.timeframe)}`))
    case 'list_isos': return j(await pveGet(host, `/nodes/${node}/storage/${validateIdentifier(args.storage, 'storage')}/content?content=iso`))
    case 'list_templates': return j(await pveGet(host, `/nodes/${node}/storage/${validateIdentifier(args.storage, 'storage')}/content?content=vztmpl`))

    // ─── VM read ───
    case 'list_vms': return j(await pveGet(host, `/nodes/${node}/qemu`))
    case 'get_vm_status': return j(await pveGet(host, `/nodes/${node}/qemu/${vmid}/status/current`))
    case 'get_vm_config': return j(await pveGet(host, `/nodes/${node}/qemu/${vmid}/config`))
    case 'get_vm_rrd': return j(await pveGet(host, `/nodes/${node}/qemu/${vmid}/rrddata?timeframe=${validateTimeframe(args.timeframe)}`))

    // ─── VM power ───
    case 'start_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/status/start`))
    case 'stop_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/status/stop`))
    case 'shutdown_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/status/shutdown`))
    case 'reboot_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/status/reboot`))
    case 'suspend_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/status/suspend`))
    case 'resume_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/status/resume`))

    // ─── VM create/clone/delete ───
    case 'create_vm': return j(await pvePost(host, `/nodes/${node}/qemu`, bodyFrom(args)))
    case 'clone_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/clone`, bodyFrom(args)))
    case 'delete_vm': return j(await pveDelete(host, `/nodes/${node}/qemu/${vmid}?${new URLSearchParams(Object.entries(bodyFrom(args)).map(([k, v]) => [k, String(v)])).toString()}`))
    case 'convert_vm_to_template': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/template`))

    // ─── VM config ───
    case 'update_vm_config': return j(await pvePut(host, `/nodes/${node}/qemu/${vmid}/config`, bodyFrom(args)))
    case 'resize_vm_disk': return j(await pvePut(host, `/nodes/${node}/qemu/${vmid}/resize`, { disk: args.disk, size: args.size }))

    // ─── VM cloud-init ───
    case 'set_vm_cloudinit': return j(await pvePut(host, `/nodes/${node}/qemu/${vmid}/config`, bodyFrom(args)))
    case 'regenerate_cloudinit': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/cloudinit`))

    // ─── VM exec ───
    case 'exec_vm_command': {
      const cmd = args.command as string
      // Wrap in /bin/sh -c so the full shell command is executed correctly
      // Proxmox agent/exec expects an executable path, not a shell string
      const result = await pvePost(host, `/nodes/${node}/qemu/${vmid}/agent/exec`, {
        command: '/bin/sh',
        'input-data': `${cmd}\n`,
      })
      const pid = (result as { pid?: number })?.pid
      if (pid !== undefined) {
        // Poll for completion: 500ms, 1s, 2s, 3s (max ~6.5s)
        const delays = [500, 1000, 2000, 3000]
        for (const delay of delays) {
          await new Promise(r => setTimeout(r, delay))
          try {
            const output = await pveGet(host, `/nodes/${node}/qemu/${vmid}/agent/exec-status?pid=${pid}`)
            const status = output as { exited?: boolean }
            if (status.exited) return j(output)
          } catch { /* not ready yet */ }
        }
        return j({ pid, note: 'Command still running. Poll exec-status manually for result.' })
      }
      return j(result)
    }

    // ─── VM migration ───
    case 'migrate_vm': return j(await pvePost(host, `/nodes/${node}/qemu/${vmid}/migrate`, bodyFrom(args)))

    // ─── Container read ───
    case 'list_containers': return j(await pveGet(host, `/nodes/${node}/lxc`))
    case 'get_container_status': return j(await pveGet(host, `/nodes/${node}/lxc/${vmid}/status/current`))
    case 'get_container_config': return j(await pveGet(host, `/nodes/${node}/lxc/${vmid}/config`))

    // ─── Container power ───
    case 'start_container': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/status/start`))
    case 'stop_container': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/status/stop`))
    case 'shutdown_container': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/status/shutdown`))
    case 'reboot_container': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/status/reboot`))

    // ─── Container create/clone/delete ───
    case 'create_container': return j(await pvePost(host, `/nodes/${node}/lxc`, { vmid, ...bodyFrom(args) }))
    case 'clone_container': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/clone`, bodyFrom(args)))
    case 'delete_container': {
      const params = bodyFrom(args)
      const qs = Object.keys(params).length ? `?${new URLSearchParams(Object.entries(params).map(([k, v]) => [k, String(v)])).toString()}` : ''
      return j(await pveDelete(host, `/nodes/${node}/lxc/${vmid}${qs}`))
    }
    case 'convert_container_to_template': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/template`))

    // ─── Container config ───
    case 'update_container_config': return j(await pvePut(host, `/nodes/${node}/lxc/${vmid}/config`, bodyFrom(args)))
    case 'resize_container_disk': return j(await pvePut(host, `/nodes/${node}/lxc/${vmid}/resize`, { disk: args.disk, size: args.size }))
    case 'migrate_container': return j(await pvePost(host, `/nodes/${node}/lxc/${vmid}/migrate`, bodyFrom(args)))

    // ─── Snapshots ───
    case 'list_snapshots': return j(await pveGet(host, `/nodes/${node}/${vmType}/${vmid}/snapshot`))
    case 'create_snapshot': {
      const snap = validateIdentifier(args.snapname, 'snapname')
      const body: Record<string, unknown> = { snapname: snap }
      if (args.description) body.description = args.description
      return j(await pvePost(host, `/nodes/${node}/${vmType}/${vmid}/snapshot`, body))
    }
    case 'delete_snapshot': return j(await pveDelete(host, `/nodes/${node}/${vmType}/${vmid}/snapshot/${validateIdentifier(args.snapname, 'snapname')}`))
    case 'rollback_snapshot': return j(await pvePost(host, `/nodes/${node}/${vmType}/${vmid}/snapshot/${validateIdentifier(args.snapname, 'snapname')}/rollback`))

    // ─── Backups ───
    case 'list_backups': {
      const filter = vmid ? `&vmid=${vmid}` : ''
      return j(await pveGet(host, `/nodes/${node}/storage/${validateIdentifier(args.storage, 'storage')}/content?content=backup${filter}`))
    }
    case 'backup_vm': return j(await pvePost(host, `/nodes/${node}/vzdump`, { vmid, ...bodyFrom(args) }))

    // ─── Firewall ───
    case 'list_firewall_rules': return j(await pveGet(host, `/nodes/${node}/${vmType}/${vmid}/firewall/rules`))
    case 'add_firewall_rule': return j(await pvePost(host, `/nodes/${node}/${vmType}/${vmid}/firewall/rules`, bodyFrom(args, ['type'])))

    default: throw new Error(`Unknown tool: ${name}`)
  }
}

// ── MCP Server setup ────────────────────────────────────────────────────────

const server = new Server(
  { name: 'proxmox-mcp-server', version: '0.1.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: readOnly ? TOOLS.filter(t => !WRITE_TOOLS.has(t.name)) : TOOLS,
}))

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params
  const ts = new Date().toISOString()
  const safeArgs = { ...args as Record<string, unknown> }
  delete safeArgs.password // never log secrets
  process.stderr.write(`[${ts}] tool=${name} args=${JSON.stringify(safeArgs)}\n`)

  if (readOnly && WRITE_TOOLS.has(name)) {
    const msg = `PROXMOX_READ_ONLY is enabled — tool "${name}" is blocked. Only read operations are allowed.`
    process.stderr.write(`[${ts}] BLOCKED (read-only): ${name}\n`)
    return { content: [{ type: 'text', text: msg }], isError: true }
  }

  try {
    const result = await handleTool(name, args as Record<string, unknown>)
    return { content: [{ type: 'text', text: result }] }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err)
    process.stderr.write(`[${ts}] ERROR tool=${name}: ${message}\n`)
    return { content: [{ type: 'text', text: `Error: ${message}` }], isError: true }
  }
})

// ── Connect ─────────────────────────────────────────────────────────────────

const transport = new StdioServerTransport()
await server.connect(transport)
const mode = readOnly ? ', READ-ONLY' : ''
process.stderr.write(`proxmox-mcp-server: connected (${hosts.length} host(s): ${hostNames.join(', ')}${mode})\n`)
