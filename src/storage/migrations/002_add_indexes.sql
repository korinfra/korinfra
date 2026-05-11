-- Add composite indexes for common queries
CREATE INDEX IF NOT EXISTS idx_resources_scan_type ON resources(scan_id, type);
CREATE INDEX IF NOT EXISTS idx_recommendations_scan_resource_status ON recommendations(scan_id, resource_id, status);
CREATE INDEX IF NOT EXISTS idx_costs_scan_service_date ON costs(scan_id, service_name, cost_date);
