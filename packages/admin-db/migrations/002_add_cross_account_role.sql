-- Add cross-account role ARN for SaaS mode
-- In SaaS mode, this is the IAM role ARN that Starkeeper will assume to access the customer's AWS account
-- In self-hosted mode, this field is NULL (uses local AWS credentials)

ALTER TABLE aws_settings
ADD COLUMN role_arn VARCHAR(2048),
ADD COLUMN external_id VARCHAR(255);

-- Add comment explaining the fields
COMMENT ON COLUMN aws_settings.role_arn IS 'IAM Role ARN for cross-account access (SaaS mode only)';
COMMENT ON COLUMN aws_settings.external_id IS 'External ID for AssumeRole (SaaS mode only, for added security)';

-- Index for querying by role ARN
CREATE INDEX idx_aws_settings_role_arn ON aws_settings(role_arn) WHERE role_arn IS NOT NULL;
