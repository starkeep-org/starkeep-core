/**
 * The admin's AWS credentials for the maintenance scripts in this folder:
 * from the environment, or else from the admin session that `starkeep login
 * --admin` keeps. See `src/operations/admin-lane.ts`.
 */
import { adminLaneCredentials } from "../src/operations/admin-lane";

export interface BaseCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken: string;
}

export const adminBaseCredentials = (): Promise<BaseCredentials> => adminLaneCredentials();
