/**
 * Central command registry — single source of truth for all known commands.
 *
 * Consumed by app.tsx, CommandPaletteOverlay, and any component that needs
 * the full command list or metadata.
 */

export interface CommandDef {
  id: string;
  label: string;
  description: string;
  /** Menu / palette group. */
  group: 'analyze' | 'action' | 'setup';
  aliases?: string[];
  /** When true, command is excluded from palette and menu listings. */
  hidden?: boolean;
  requiresConfig?: boolean;
  requiresAws?: boolean;
  requiresAi?: boolean;
}

export const COMMAND_REGISTRY: CommandDef[] = [
  { id: 'scan',      label: 'scan',      description: 'Full infrastructure scan',                     group: 'analyze', requiresConfig: true,  requiresAws: true,  requiresAi: false },
  { id: 'costs',     label: 'costs',     description: 'Cost breakdown and anomaly detection',          group: 'analyze', requiresConfig: true,  requiresAws: true,  requiresAi: false },
  { id: 'resources', label: 'resources', description: 'Browse AWS resources',                         group: 'analyze', requiresConfig: true,  requiresAws: true,  requiresAi: false },
  { id: 'security',  label: 'security',  description: 'Terraform security checks',                    group: 'analyze', requiresConfig: false, requiresAws: false, requiresAi: false },
  { id: 'history',   label: 'history',   description: 'View scan history',                            group: 'analyze', requiresConfig: true,  requiresAws: false, requiresAi: false },
  { id: 'changes',   label: 'changes',   description: 'Audit recent AWS API activity',                  group: 'analyze', requiresConfig: true,  requiresAws: true,  requiresAi: false },
  { id: 'rules',     label: 'rules',     description: 'Browse built-in cost optimization rules',        group: 'analyze', requiresConfig: false, requiresAws: false, requiresAi: false },
  { id: 'recommend', label: 'recommend', description: 'Cost and security recommendations',            group: 'action',  requiresConfig: true,  requiresAws: false, requiresAi: false },
  { id: 'fix',       label: 'fix',       description: 'Apply recommended fixes',                      group: 'action',  requiresConfig: true,  requiresAws: false, requiresAi: true  },
  { id: 'report',    label: 'report',    description: 'Generate cost report',                         group: 'action',  requiresConfig: true,  requiresAws: false, requiresAi: false },
  { id: 'tags',      label: 'tags',      description: 'Audit tag compliance',                         group: 'action',  requiresConfig: true,  requiresAws: true,  requiresAi: false },
  { id: 'pricing',   label: 'pricing',   description: 'Look up AWS pricing',                          group: 'action',  requiresConfig: false, requiresAws: false, requiresAi: false },
  { id: 'init',      label: 'init',      description: 'Initialize config',                            group: 'setup',   requiresConfig: false, requiresAws: false, requiresAi: false },
  { id: 'doctor',    label: 'doctor',    description: 'Diagnose environment',                         group: 'setup',   requiresConfig: false, requiresAws: false, requiresAi: false },
  { id: 'config',    label: 'config',    description: 'View or edit configuration',                   group: 'setup',   requiresConfig: false, requiresAws: false, requiresAi: false },
  { id: 'mcp',       label: 'mcp',       description: 'Install MCP server for IDE integration',       group: 'setup',   requiresConfig: false, requiresAws: false, requiresAi: false },
];

/** Flat list of all known command IDs and their aliases. */
export const KNOWN_COMMAND_IDS: string[] = COMMAND_REGISTRY.flatMap((c) => [c.id, ...(c.aliases ?? [])]);
