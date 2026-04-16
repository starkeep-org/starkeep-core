#!/usr/bin/env node
/**
 * Run database migrations
 *
 * Usage:
 *   DATABASE_URL=postgresql://... npm run migrate
 */

import { readdir, readFile } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { getPool, closePool } from "../src/client.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

async function runMigrations() {
  const pool = getPool();

  try {
    // Create migrations tracking table
    await pool.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL UNIQUE,
        applied_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
      )
    `);

    // Get list of migration files
    const migrationsDir = join(__dirname, "../migrations");
    const files = await readdir(migrationsDir);
    const sqlFiles = files
      .filter((f) => f.endsWith(".sql"))
      .sort(); // Ensure migrations run in order

    console.log(`📁 Found ${sqlFiles.length} migration files\n`);

    // Get already applied migrations
    const { rows: applied } = await pool.query(
      "SELECT name FROM migrations ORDER BY name"
    );
    const appliedNames = new Set(applied.map((r) => r.name));

    let appliedCount = 0;
    let skippedCount = 0;

    // Run each migration
    for (const file of sqlFiles) {
      if (appliedNames.has(file)) {
        console.log(`⏭️  Skipping ${file} (already applied)`);
        skippedCount++;
        continue;
      }

      console.log(`🔄 Running ${file}...`);

      const filePath = join(migrationsDir, file);
      const sql = await readFile(filePath, "utf-8");

      // Run migration in a transaction
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(sql);
        await client.query(
          "INSERT INTO migrations (name) VALUES ($1)",
          [file]
        );
        await client.query("COMMIT");
        console.log(`✅ Applied ${file}`);
        appliedCount++;
      } catch (error) {
        await client.query("ROLLBACK");
        console.error(`❌ Failed to apply ${file}:`, error);
        throw error;
      } finally {
        client.release();
      }
    }

    console.log(`\n✨ Migration complete!`);
    console.log(`   Applied: ${appliedCount}`);
    console.log(`   Skipped: ${skippedCount}`);
    console.log(`   Total: ${sqlFiles.length}`);

  } catch (error) {
    console.error("\n💥 Migration failed:", error);
    process.exit(1);
  } finally {
    await closePool();
  }
}

// Run if called directly
if (import.meta.url === `file://${process.argv[1]}`) {
  runMigrations();
}

export { runMigrations };
