-- Seed data: Default customer for demo/testing
-- This ensures the hardcoded "default-customer" references in the app work

-- Use a fixed UUID for the default customer to match app references
-- UUID: 00000000-0000-0000-0000-000000000001 (easy to remember for demo)
INSERT INTO customers (id, email, name, created_at, updated_at)
VALUES (
  '00000000-0000-0000-0000-000000000001',
  'demo@starkeeper.dev',
  'Demo Customer',
  NOW(),
  NOW()
)
ON CONFLICT (id) DO NOTHING;

COMMENT ON TABLE customers IS 'Customer/tenant accounts. In production, this would be populated from authentication system.';
