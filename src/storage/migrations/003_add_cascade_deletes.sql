-- Add ON DELETE CASCADE to foreign keys
-- SQLite doesn't support modifying constraints, so we recreate tables

ALTER TABLE resources RENAME TO resources_old;
CREATE TABLE resources (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    resource_id TEXT NOT NULL,
    arn TEXT,
    type TEXT NOT NULL,
    name TEXT,
    region TEXT,
    state TEXT,
    instance_type TEXT,
    monthly_cost REAL DEFAULT 0,
    monthly_cost_source TEXT,
    tags TEXT,
    utilization TEXT,
    configuration TEXT,
    scenario TEXT,
    terraform_address TEXT,
    collected_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO resources SELECT id, scan_id, resource_id, arn, type, name, region, state, instance_type, monthly_cost, NULL, tags, utilization, configuration, scenario, terraform_address, collected_at, created_at FROM resources_old;
DROP TABLE resources_old;

ALTER TABLE costs RENAME TO costs_old;
CREATE TABLE costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    service_name TEXT NOT NULL,
    region TEXT,
    cost_date DATE NOT NULL,
    daily_cost REAL DEFAULT 0,
    monthly_cost REAL DEFAULT 0,
    currency TEXT DEFAULT 'USD',
    usage_type TEXT,
    tags TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO costs SELECT * FROM costs_old;
DROP TABLE costs_old;

ALTER TABLE recommendations RENAME TO recommendations_old;
CREATE TABLE recommendations (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id) ON DELETE CASCADE,
    resource_id TEXT,
    resource_type TEXT,
    type TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT,
    reasoning TEXT,
    estimated_savings REAL DEFAULT 0,
    confidence REAL DEFAULT 0,
    quality_score INTEGER DEFAULT 0,
    impact TEXT DEFAULT 'medium',
    risk TEXT DEFAULT 'low',
    status TEXT DEFAULT 'draft',
    current_config TEXT,
    suggested_config TEXT,
    patch_content TEXT,
    file_path TEXT,
    implementation_steps TEXT,
    ai_model TEXT,
    scenario TEXT,
    applied_at DATETIME,
    dismissed_at DATETIME,
    dismiss_reason TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO recommendations SELECT * FROM recommendations_old;
DROP TABLE recommendations_old;

ALTER TABLE api_call_log RENAME TO api_call_log_old;
CREATE TABLE api_call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT REFERENCES scans(id) ON DELETE CASCADE,
    service TEXT NOT NULL,
    operation TEXT NOT NULL,
    region TEXT,
    estimated_cost REAL DEFAULT 0,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);
INSERT INTO api_call_log SELECT * FROM api_call_log_old;
DROP TABLE api_call_log_old;
