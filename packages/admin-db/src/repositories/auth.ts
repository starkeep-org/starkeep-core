import { getPool } from "../client.js";
import type { QueryResult } from "pg";
import { requireRow } from "./rows.js";

export interface User {
  id: string;
  email: string;
  email_verified_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CustomerMembership {
  user_id: string;
  customer_id: string;
  role: string;
  created_at: Date;
}

export interface AuthPassword {
  user_id: string;
  password_hash: string;
  password_updated_at: Date;
}

export interface AuthSession {
  id: string;
  user_id: string;
  created_at: Date;
  last_seen_at: Date | null;
  expires_at: Date;
  revoked_at: Date | null;
  token_hash: string | null;
}

export interface AuthMagicLink {
  id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
}

export interface AuthTotp {
  user_id: string;
  secret_encrypted: string;
  enabled_at: Date;
}

export interface AuthInvitation {
  id: string;
  customer_id: string;
  email: string;
  token_hash: string;
  expires_at: Date;
  consumed_at: Date | null;
  created_at: Date;
  created_by_user_id: string;
}

export interface AuthRecoveryCode {
  user_id: string;
  code_hash: string;
  used_at: Date | null;
  created_at: Date;
}

export class AuthRepository {
  async findUserByEmail(email: string): Promise<User | null> {
    const pool = getPool();
    const result: QueryResult<User> = await pool.query(
      "SELECT * FROM users WHERE email = $1",
      [email]
    );
    return result.rows[0] || null;
  }

  async findUserById(id: string): Promise<User | null> {
    const pool = getPool();
    const result: QueryResult<User> = await pool.query(
      "SELECT * FROM users WHERE id = $1",
      [id]
    );
    return result.rows[0] || null;
  }

  async createUser(email: string): Promise<User> {
    const pool = getPool();
    const result: QueryResult<User> = await pool.query(
      `INSERT INTO users (email)
       VALUES ($1)
       RETURNING *`,
      [email]
    );
    return requireRow(result, "Failed to create user");
  }

  async createMembership(userId: string, customerId: string, role = "member"): Promise<CustomerMembership> {
    const pool = getPool();
    const result: QueryResult<CustomerMembership> = await pool.query(
      `INSERT INTO customer_memberships (user_id, customer_id, role)
       VALUES ($1, $2, $3)
       ON CONFLICT (user_id, customer_id) DO NOTHING
       RETURNING *`,
      [userId, customerId, role]
    );
    if (result.rows[0]) {
      return result.rows[0];
    }

    const existing: QueryResult<CustomerMembership> = await pool.query(
      "SELECT * FROM customer_memberships WHERE user_id = $1 AND customer_id = $2",
      [userId, customerId]
    );
    return requireRow(existing, "Membership not found");
  }

  async findMembership(userId: string, customerId: string): Promise<CustomerMembership | null> {
    const pool = getPool();
    const result: QueryResult<CustomerMembership> = await pool.query(
      "SELECT * FROM customer_memberships WHERE user_id = $1 AND customer_id = $2",
      [userId, customerId]
    );
    return result.rows[0] || null;
  }

  async findMembershipsByUserId(userId: string): Promise<CustomerMembership[]> {
    const pool = getPool();
    const result: QueryResult<CustomerMembership> = await pool.query(
      "SELECT * FROM customer_memberships WHERE user_id = $1 ORDER BY created_at ASC",
      [userId]
    );
    return result.rows;
  }

  async findPrimaryCustomerId(userId: string): Promise<string | null> {
    const pool = getPool();
    const result: QueryResult<{ customer_id: string }> = await pool.query(
      "SELECT customer_id FROM customer_memberships WHERE user_id = $1 ORDER BY created_at ASC LIMIT 1",
      [userId]
    );
    return result.rows[0]?.customer_id || null;
  }

  async upsertPassword(userId: string, passwordHash: string): Promise<AuthPassword> {
    const pool = getPool();
    const result: QueryResult<AuthPassword> = await pool.query(
      `INSERT INTO auth_passwords (user_id, password_hash)
       VALUES ($1, $2)
       ON CONFLICT (user_id)
       DO UPDATE SET password_hash = EXCLUDED.password_hash, password_updated_at = NOW()
       RETURNING *`,
      [userId, passwordHash]
    );
    return requireRow(result, "Failed to upsert password");
  }

  async getPassword(userId: string): Promise<AuthPassword | null> {
    const pool = getPool();
    const result: QueryResult<AuthPassword> = await pool.query(
      "SELECT * FROM auth_passwords WHERE user_id = $1",
      [userId]
    );
    return result.rows[0] || null;
  }

  async findSessionById(sessionId: string): Promise<AuthSession | null> {
    const pool = getPool();
    const result: QueryResult<AuthSession> = await pool.query(
      `SELECT * FROM auth_sessions
       WHERE id = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [sessionId]
    );
    return result.rows[0] || null;
  }

  async touchSession(sessionId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE auth_sessions SET last_seen_at = NOW() WHERE id = $1",
      [sessionId]
    );
  }

  async revokeSession(sessionId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE auth_sessions SET revoked_at = NOW() WHERE id = $1",
      [sessionId]
    );
  }

  async createMagicLink(userId: string, tokenHash: string, expiresAt: Date): Promise<AuthMagicLink> {
    const pool = getPool();
    const result: QueryResult<AuthMagicLink> = await pool.query(
      `INSERT INTO auth_magic_links (user_id, token_hash, expires_at)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, tokenHash, expiresAt]
    );
    return requireRow(result, "Failed to create magic link");
  }

  async consumeMagicLink(tokenHash: string): Promise<AuthMagicLink | null> {
    const pool = getPool();
    const result: QueryResult<AuthMagicLink> = await pool.query(
      `UPDATE auth_magic_links
       SET consumed_at = NOW()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING *`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  async upsertTotp(userId: string, secretEncrypted: string): Promise<AuthTotp> {
    const pool = getPool();
    const result: QueryResult<AuthTotp> = await pool.query(
      `INSERT INTO auth_totp (user_id, secret_encrypted, enabled_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (user_id)
       DO UPDATE SET secret_encrypted = EXCLUDED.secret_encrypted, enabled_at = NOW()
       RETURNING *`,
      [userId, secretEncrypted]
    );
    return requireRow(result, "Failed to upsert TOTP");
  }

  async getTotp(userId: string): Promise<AuthTotp | null> {
    const pool = getPool();
    const result: QueryResult<AuthTotp> = await pool.query(
      "SELECT * FROM auth_totp WHERE user_id = $1",
      [userId]
    );
    return result.rows[0] || null;
  }

  async replaceRecoveryCodes(userId: string, codeHashes: string[]): Promise<AuthRecoveryCode[]> {
    const pool = getPool();
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("DELETE FROM auth_recovery_codes WHERE user_id = $1", [userId]);

      const values: any[] = [];
      const placeholders: string[] = [];
      let paramCount = 1;

      codeHashes.forEach((hash) => {
        placeholders.push(`($${paramCount++}, $${paramCount++})`);
        values.push(userId, hash);
      });

      if (placeholders.length === 0) {
        await client.query("COMMIT");
        return [];
      }

      const result: QueryResult<AuthRecoveryCode> = await client.query(
        `INSERT INTO auth_recovery_codes (user_id, code_hash)
         VALUES ${placeholders.join(", ")}
         RETURNING *`,
        values
      );
      await client.query("COMMIT");
      return result.rows;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }

  async consumeRecoveryCode(userId: string, codeHash: string): Promise<AuthRecoveryCode | null> {
    const pool = getPool();
    const result: QueryResult<AuthRecoveryCode> = await pool.query(
      `UPDATE auth_recovery_codes
       SET used_at = NOW()
       WHERE user_id = $1 AND code_hash = $2 AND used_at IS NULL
       RETURNING *`,
      [userId, codeHash]
    );
    return result.rows[0] || null;
  }

  async markEmailVerified(userId: string): Promise<void> {
    const pool = getPool();
    await pool.query(
      "UPDATE users SET email_verified_at = NOW() WHERE id = $1 AND email_verified_at IS NULL",
      [userId]
    );
  }

  async createInvitation(
    customerId: string,
    email: string,
    tokenHash: string,
    expiresAt: Date,
    createdByUserId: string
  ): Promise<AuthInvitation> {
    const pool = getPool();
    const result: QueryResult<AuthInvitation> = await pool.query(
      `INSERT INTO auth_invitations (
        customer_id, email, token_hash, expires_at, created_by_user_id
      )
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [customerId, email, tokenHash, expiresAt, createdByUserId]
    );
    return requireRow(result, "Failed to create invitation");
  }

  async consumeInvitation(tokenHash: string): Promise<AuthInvitation | null> {
    const pool = getPool();
    const result: QueryResult<AuthInvitation> = await pool.query(
      `UPDATE auth_invitations
       SET consumed_at = NOW()
       WHERE token_hash = $1 AND consumed_at IS NULL AND expires_at > NOW()
       RETURNING *`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  // --- API Token Sessions ---

  async createSession(userId: string, expiresAt: Date, tokenHash?: string): Promise<AuthSession> {
    const pool = getPool();
    const result: QueryResult<AuthSession> = await pool.query(
      `INSERT INTO auth_sessions (user_id, expires_at, token_hash)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, expiresAt, tokenHash ?? null]
    );
    return requireRow(result, "Failed to create session");
  }

  async findSessionByToken(tokenHash: string): Promise<AuthSession | null> {
    const pool = getPool();
    const result: QueryResult<AuthSession> = await pool.query(
      `SELECT * FROM auth_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > NOW()`,
      [tokenHash]
    );
    return result.rows[0] || null;
  }

  async getMembershipsForUser(userId: string): Promise<CustomerMembership[]> {
    const pool = getPool();
    const result: QueryResult<CustomerMembership> = await pool.query(
      "SELECT * FROM customer_memberships WHERE user_id = $1",
      [userId]
    );
    return result.rows;
  }
}
