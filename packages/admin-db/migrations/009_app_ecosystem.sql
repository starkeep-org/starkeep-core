-- Type registry: globally registered data types
CREATE TABLE type_registrations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  type_id TEXT NOT NULL UNIQUE,
  schema_version TEXT NOT NULL DEFAULT '1.0.0',
  description TEXT NOT NULL DEFAULT '',
  schema JSONB,
  registered_by_app_id TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_type_registrations_type_id ON type_registrations(type_id);

-- App registry: installed apps and their state
CREATE TABLE app_registry (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  app_id TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  tier TEXT NOT NULL CHECK (tier IN ('official', 'verified', 'community')),
  manifest JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'installing', 'degraded', 'uninstalling')),
  policy_ids TEXT[] DEFAULT '{}',
  registered_type_ids TEXT[] DEFAULT '{}',
  installed_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_app_registry_app_id ON app_registry(app_id);
CREATE INDEX idx_app_registry_status ON app_registry(status);

-- Infrastructure catalog: all managed AWS resources
CREATE TABLE infra_catalog (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  name TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('core', 'app')),
  owner_app_id TEXT,
  resolved_for_apps TEXT[] DEFAULT '{}',
  tags JSONB DEFAULT '{}',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_infra_catalog_resource_type ON infra_catalog(resource_type);

-- Access policies: who can access what
CREATE TABLE access_policies (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  subject_type TEXT NOT NULL,
  subject_id TEXT NOT NULL,
  resource_type TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  permissions TEXT[] NOT NULL,
  granted_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  expires_at TIMESTAMP WITH TIME ZONE,
  revoked_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_access_policies_subject ON access_policies(subject_type, subject_id);
CREATE INDEX idx_access_policies_resource ON access_policies(resource_type, resource_id);
