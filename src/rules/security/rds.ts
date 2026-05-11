/**
 * RDS security rules.
 * Ported from Go internal/terraform/scanner.go RDS section.
 */

import type { SecurityRule } from './types.js';

export const rdsRules: SecurityRule[] = [
  {
    id: 'RDS-SEC-001',
    title: 'RDS instance publicly accessible',
    description: 'RDS instance is publicly accessible from the internet',
    severity: 'critical',
    resourceTypes: ['aws_db_instance'],
    evaluate: (res) => res.configuration['publicly_accessible'] === true,
    recommendation: 'Set publicly_accessible = false',
  },
  {
    id: 'RDS-SEC-002',
    title: 'RDS instance not encrypted',
    description: 'RDS instance does not have storage encryption enabled',
    severity: 'high',
    resourceTypes: ['aws_db_instance'],
    evaluate: (res) => res.configuration['storage_encrypted'] === false,
    recommendation: 'Set storage_encrypted = true on the RDS instance',
  },
  {
    id: 'RDS-SEC-003',
    title: 'RDS instance without backup',
    description: 'RDS instance has backup retention set to 0 (no automated backups)',
    severity: 'high',
    resourceTypes: ['aws_db_instance'],
    evaluate: (res) => {
      const retention = res.configuration['backup_retention_period'];
      if (retention === undefined) return true; // default is 0 if not specified
      if (typeof retention === 'number') return retention === 0;
      return false;
    },
    recommendation: 'Set backup_retention_period to at least 7 days',
  },
  {
    id: 'RDS-SEC-004',
    title: 'RDS instance without deletion protection',
    description: 'RDS instance does not have deletion protection enabled',
    severity: 'medium',
    resourceTypes: ['aws_db_instance'],
    evaluate: (res) => res.configuration['deletion_protection'] !== true,
    recommendation: 'Set deletion_protection = true to prevent accidental database deletion',
  },
];
