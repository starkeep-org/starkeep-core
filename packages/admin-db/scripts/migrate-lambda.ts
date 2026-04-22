import { runMigrations } from "./run-migrations.js";

export async function handler(event: any) {
  try {
    console.log("Running database migrations...");
    await runMigrations();
    console.log("Migrations completed successfully");

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Migrations completed successfully" }),
    };
  } catch (error) {
    console.error("Migration failed:", error);
    throw error;
  }
}
