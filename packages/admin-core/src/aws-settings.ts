/**
 * AWS Settings Service (Legacy - Deprecated)
 *
 * This service is deprecated. Use AwsSettingsRepository from @starkeep/admin-db instead.
 * All AWS connections now use cross-account roles for consistent security model.
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

/**
 * @deprecated Use AwsSettingsRepository from @starkeep/admin-db instead
 */
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
