-- Starkeeper Database Schema
-- Initial migration: deployments, plans, templates, and settings

-- Enable UUID extension
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";

-- Users/Customers table
CREATE TABLE customers (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(255),
  aws_account_id VARCHAR(12),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_customers_email ON customers(email);
CREATE INDEX idx_customers_aws_account ON customers(aws_account_id);

-- AWS Settings per customer
CREATE TABLE aws_settings (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  account_id VARCHAR(12) NOT NULL,
  default_region VARCHAR(50) DEFAULT 'us-east-1',
  allowed_regions TEXT[], -- Array of allowed regions
  stack_prefix VARCHAR(100) DEFAULT 'app',
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(customer_id)
);

CREATE INDEX idx_aws_settings_customer ON aws_settings(customer_id);

-- CloudFormation Templates (customer-uploaded)
CREATE TABLE templates (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  s3_bucket VARCHAR(255) NOT NULL, -- S3 bucket where template is stored
  s3_key VARCHAR(500) NOT NULL,    -- S3 object key
  version VARCHAR(50) DEFAULT '1.0.0',
  is_active BOOLEAN DEFAULT true,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  UNIQUE(customer_id, name, version)
);

CREATE INDEX idx_templates_customer ON templates(customer_id);
CREATE INDEX idx_templates_active ON templates(customer_id, is_active);

-- Deployment Plans (CloudFormation change sets)
CREATE TABLE plans (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_id UUID REFERENCES templates(id) ON DELETE SET NULL,

  -- CloudFormation details
  change_set_id VARCHAR(255), -- AWS CloudFormation change set ID
  change_set_arn TEXT,
  stack_name VARCHAR(255) NOT NULL,
  region VARCHAR(50) NOT NULL,

  -- Deployment config
  environment VARCHAR(50), -- dev, staging, prod
  parameters JSONB,        -- CloudFormation parameters
  tags JSONB,              -- CloudFormation tags

  -- Status tracking
  status VARCHAR(50) DEFAULT 'CREATED', -- CREATED, READY, APPROVED, EXECUTING, COMPLETED, FAILED

  -- Metadata
  created_by UUID REFERENCES customers(id),
  approved_by UUID REFERENCES customers(id),
  approved_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_plans_customer ON plans(customer_id);
CREATE INDEX idx_plans_status ON plans(status);
CREATE INDEX idx_plans_template ON plans(template_id);
CREATE INDEX idx_plans_created ON plans(created_at DESC);

-- Deployment executions (stack deployments)
CREATE TABLE deployments (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  plan_id UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,

  -- CloudFormation stack details
  stack_id VARCHAR(500),
  stack_arn TEXT,
  stack_name VARCHAR(255) NOT NULL,
  region VARCHAR(50) NOT NULL,

  -- Status
  status VARCHAR(50) DEFAULT 'IN_PROGRESS', -- IN_PROGRESS, COMPLETED, FAILED, ROLLED_BACK
  status_reason TEXT,

  -- Outputs from CloudFormation
  outputs JSONB,

  -- Timing
  started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  completed_at TIMESTAMP WITH TIME ZONE,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_deployments_customer ON deployments(customer_id);
CREATE INDEX idx_deployments_plan ON deployments(plan_id);
CREATE INDEX idx_deployments_status ON deployments(status);
CREATE INDEX idx_deployments_started ON deployments(started_at DESC);

-- Deployment events (CloudFormation stack events)
CREATE TABLE deployment_events (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  deployment_id UUID NOT NULL REFERENCES deployments(id) ON DELETE CASCADE,

  -- CloudFormation event details
  event_id VARCHAR(255),
  timestamp TIMESTAMP WITH TIME ZONE NOT NULL,
  resource_type VARCHAR(255),
  logical_resource_id VARCHAR(255),
  physical_resource_id VARCHAR(500),
  resource_status VARCHAR(100),
  resource_status_reason TEXT,

  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

CREATE INDEX idx_events_deployment ON deployment_events(deployment_id);
CREATE INDEX idx_events_timestamp ON deployment_events(timestamp DESC);

-- Create updated_at trigger function
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Apply updated_at triggers
CREATE TRIGGER update_customers_updated_at BEFORE UPDATE ON customers
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_aws_settings_updated_at BEFORE UPDATE ON aws_settings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_templates_updated_at BEFORE UPDATE ON templates
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_plans_updated_at BEFORE UPDATE ON plans
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_deployments_updated_at BEFORE UPDATE ON deployments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
