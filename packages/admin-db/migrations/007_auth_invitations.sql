-- Invitations for onboarding additional users to existing customers

CREATE TABLE auth_invitations (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  email CITEXT NOT NULL,
  token_hash TEXT NOT NULL,
  expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
  consumed_at TIMESTAMP WITH TIME ZONE,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
  created_by_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_auth_invitations_token_hash ON auth_invitations(token_hash);
CREATE INDEX idx_auth_invitations_customer_id ON auth_invitations(customer_id);
CREATE INDEX idx_auth_invitations_email ON auth_invitations(email);
