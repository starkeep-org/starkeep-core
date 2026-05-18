/**
 * AWS Settings Service (in-memory)
 *
 * Holds the bootstrap AWS settings for the running admin-web process. Cross-account
 * role connections are derived from this. Persistence (when needed) will live in
 * DSQL alongside the other admin-side tables.
 */

export interface AwsSettings {
  id: string;
  accountId: string;
  defaultRegion: string;
  allowedRegions?: string[];
  stackPrefix: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface SaveAwsSettingsInput {
  accountId: string;
  defaultRegion: string;
  allowedRegions?: string[];
  stackPrefix: string;
}

export class AwsSettingsService {
  // In-memory store - replace with real database
  private settings: AwsSettings | null = null;

  save(input: SaveAwsSettingsInput): AwsSettings {
    const now = new Date();

    this.settings = {
      id: "aws-settings-1",
      accountId: input.accountId,
      defaultRegion: input.defaultRegion,
      allowedRegions: input.allowedRegions,
      stackPrefix: input.stackPrefix,
      createdAt: this.settings?.createdAt || now,
      updatedAt: now,
    };

    return this.settings;
  }

  get(): AwsSettings | null {
    return this.settings;
  }

  getOrThrow(): AwsSettings {
    if (!this.settings) {
      throw new Error("AWS settings not configured. Please configure AWS settings first.");
    }
    return this.settings;
  }
}
