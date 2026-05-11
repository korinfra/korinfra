-- korinfra initial schema
-- All tables use IF NOT EXISTS for idempotent migrations.

CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    applied_at DATETIME NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS scans (
    id TEXT PRIMARY KEY,
    started_at DATETIME NOT NULL,
    completed_at DATETIME,
    status TEXT NOT NULL DEFAULT 'running',
    terraform_path TEXT,
    aws_profile TEXT,
    aws_region TEXT,
    total_resources INTEGER DEFAULT 0,
    total_cost REAL DEFAULT 0,
    total_recommendations INTEGER DEFAULT 0,
    total_savings REAL DEFAULT 0,
    scenario_a_count INTEGER DEFAULT 0,
    scenario_b_count INTEGER DEFAULT 0,
    scenario_c_count INTEGER DEFAULT 0,
    metadata TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS resources (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id),
    resource_id TEXT NOT NULL,
    arn TEXT,
    type TEXT NOT NULL,
    name TEXT,
    region TEXT,
    state TEXT,
    instance_type TEXT,
    monthly_cost REAL DEFAULT 0,
    tags TEXT,
    utilization TEXT,
    configuration TEXT,
    scenario TEXT,
    terraform_address TEXT,
    collected_at DATETIME,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT NOT NULL REFERENCES scans(id),
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

CREATE TABLE IF NOT EXISTS recommendations (
    id TEXT PRIMARY KEY,
    scan_id TEXT NOT NULL REFERENCES scans(id),
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

CREATE TABLE IF NOT EXISTS virtual_tags (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    dimension TEXT NOT NULL,
    value TEXT NOT NULL,
    allocation_pct REAL DEFAULT 100.0,
    source TEXT DEFAULT 'manual',
    confidence REAL DEFAULT 1.0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(resource_id, dimension, value)
);

CREATE TABLE IF NOT EXISTS pricing_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    service_code TEXT NOT NULL,
    resource_key TEXT NOT NULL,
    region TEXT NOT NULL,
    hourly_price REAL NOT NULL,
    price_unit TEXT DEFAULT 'Hrs',
    attributes TEXT,
    fetched_at DATETIME NOT NULL,
    expires_at DATETIME NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(service_code, resource_key, region)
);

CREATE TABLE IF NOT EXISTS api_call_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    scan_id TEXT REFERENCES scans(id),
    service TEXT NOT NULL,
    operation TEXT NOT NULL,
    region TEXT,
    estimated_cost REAL DEFAULT 0,
    duration_ms INTEGER,
    status TEXT NOT NULL,
    error_message TEXT,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_resources_scan ON resources(scan_id);
CREATE INDEX IF NOT EXISTS idx_resources_type ON resources(type);
CREATE INDEX IF NOT EXISTS idx_resources_scenario ON resources(scenario);
CREATE INDEX IF NOT EXISTS idx_costs_scan ON costs(scan_id);
CREATE INDEX IF NOT EXISTS idx_costs_service ON costs(service_name);
CREATE INDEX IF NOT EXISTS idx_costs_date ON costs(cost_date);
CREATE INDEX IF NOT EXISTS idx_recommendations_scan ON recommendations(scan_id);
CREATE INDEX IF NOT EXISTS idx_recommendations_status ON recommendations(status);
CREATE INDEX IF NOT EXISTS idx_recommendations_type ON recommendations(type);
CREATE INDEX IF NOT EXISTS idx_virtual_tags_resource ON virtual_tags(resource_id);
CREATE INDEX IF NOT EXISTS idx_pricing_cache_key ON pricing_cache(service_code, resource_key, region);
CREATE INDEX IF NOT EXISTS idx_pricing_cache_expires ON pricing_cache(expires_at);
CREATE INDEX IF NOT EXISTS idx_api_call_log_scan ON api_call_log(scan_id);
CREATE INDEX IF NOT EXISTS idx_api_call_log_service ON api_call_log(service);
CREATE INDEX IF NOT EXISTS idx_scans_created_at ON scans(created_at);
