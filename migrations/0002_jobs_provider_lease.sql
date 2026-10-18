CREATE INDEX IF NOT EXISTS jobs_provider_lease ON jobs(provider, state, lease_until, created_at);
