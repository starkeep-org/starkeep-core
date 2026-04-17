-- Make role_arn and external_id required (NOT NULL)
-- This reflects the simplified architecture where all deployments use cross-account roles

-- Update existing NULL values to a placeholder (if any exist)
-- In production, you'd want to handle this more carefully or ensure no NULLs exist
UPDATE aws_settings
SET role_arn = 'PLACEHOLDER_ROLE_ARN'
WHERE role_arn IS NULL;

UPDATE aws_settings
SET external_id = 'PLACEHOLDER_EXTERNAL_ID'
WHERE external_id IS NULL;

-- Now make the columns NOT NULL
ALTER TABLE aws_settings
ALTER COLUMN role_arn SET NOT NULL,
ALTER COLUMN external_id SET NOT NULL;

-- Update comments to reflect that these are always required
COMMENT ON COLUMN aws_settings.role_arn IS 'IAM Role ARN for cross-account access (required for all deployments)';
COMMENT ON COLUMN aws_settings.external_id IS 'External ID for AssumeRole security (required for all deployments)';
