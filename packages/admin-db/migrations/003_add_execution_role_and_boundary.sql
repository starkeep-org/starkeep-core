-- Add CloudFormation execution role ARN and permission boundary ARN for enhanced security
-- These are created by the bootstrap CloudFormation stack

ALTER TABLE aws_settings
ADD COLUMN execution_role_arn VARCHAR(2048),
ADD COLUMN permission_boundary_arn VARCHAR(2048);

-- Add comments explaining the fields
COMMENT ON COLUMN aws_settings.execution_role_arn IS 'CloudFormation execution role ARN (used by CloudFormation service)';
COMMENT ON COLUMN aws_settings.permission_boundary_arn IS 'Permission boundary ARN for IAM roles created by templates';

-- Index for querying by execution role ARN
CREATE INDEX idx_aws_settings_execution_role_arn ON aws_settings(execution_role_arn) WHERE execution_role_arn IS NOT NULL;
