/**
 * Setup script to create IAM user for Starkeeper control plane
 *
 * This creates an IAM user that can assume cross-account roles.
 * Root accounts cannot assume roles, so we need a dedicated IAM user.
 *
 * Usage:
 *   npx tsx scripts/setup-control-plane-user.ts
 */

import {
  IAMClient,
  CreateUserCommand,
  AttachUserPolicyCommand,
  CreateAccessKeyCommand,
  GetUserCommand,
} from "@aws-sdk/client-iam";

async function setupControlPlaneUser() {
  const iam = new IAMClient({ region: "us-east-1" });
  const userName = "starkeeper-control-plane";

  console.log("🚀 Setting up Starkeeper Control Plane IAM User...\n");

  try {
    // Check if user already exists
    try {
      await iam.send(new GetUserCommand({ UserName: userName }));
      console.log(`✅ User '${userName}' already exists`);
      console.log("⚠️  Skipping user creation. If you need new credentials, create them manually in the AWS Console.\n");
      return;
    } catch (error: any) {
      if (error.name !== "NoSuchEntity" && !error.message?.includes("cannot be found")) {
        throw error;
      }
      // User doesn't exist, continue with creation
      console.log(`📝 User '${userName}' does not exist, creating...\n`);
    }

    // Create IAM user
    console.log(`📝 Creating IAM user: ${userName}...`);
    await iam.send(
      new CreateUserCommand({
        UserName: userName,
        Tags: [
          { Key: "Purpose", Value: "Starkeeper Control Plane" },
          { Key: "ManagedBy", Value: "starkeeper-setup-script" },
        ],
      })
    );
    console.log(`✅ Created user: ${userName}\n`);

    // Attach AdministratorAccess policy
    console.log("🔐 Attaching AdministratorAccess policy...");
    await iam.send(
      new AttachUserPolicyCommand({
        UserName: userName,
        PolicyArn: "arn:aws:iam::aws:policy/AdministratorAccess",
      })
    );
    console.log("✅ Attached AdministratorAccess policy\n");

    // Create access key
    console.log("🔑 Creating access key...");
    const accessKeyResponse = await iam.send(
      new CreateAccessKeyCommand({
        UserName: userName,
      })
    );

    const accessKey = accessKeyResponse.AccessKey;
    if (!accessKey) {
      throw new Error("Failed to create access key");
    }

    console.log("\n✨ Setup Complete!\n");
    console.log("=" .repeat(60));
    console.log("AWS CREDENTIALS FOR STARKEEPER CONTROL PLANE");
    console.log("=" .repeat(60));
    console.log("\n⚠️  IMPORTANT: Save these credentials securely!");
    console.log("⚠️  You won't be able to see the secret key again!\n");
    console.log(`AWS_ACCESS_KEY_ID=${accessKey.AccessKeyId}`);
    console.log(`AWS_SECRET_ACCESS_KEY=${accessKey.SecretAccessKey}`);
    console.log("\n" + "=".repeat(60));
    console.log("\n📝 Next Steps:\n");
    console.log("1. Copy the credentials above");
    console.log("2. Update your .env file:");
    console.log("   - Replace AWS_ACCESS_KEY_ID");
    console.log("   - Replace AWS_SECRET_ACCESS_KEY");
    console.log("3. Restart your dev server");
    console.log("4. Try creating a deployment again!\n");

  } catch (error: any) {
    console.error("\n❌ Error:", error.message);

    if (error.name === "InvalidClientTokenId" || error.message?.includes("security token")) {
      console.error("\n⚠️  Your current AWS credentials are invalid.");
      console.error("Please ensure you have valid AWS credentials configured.");
      console.error("\nOptions:");
      console.error("1. Set environment variables:");
      console.error("   export AWS_ACCESS_KEY_ID=...");
      console.error("   export AWS_SECRET_ACCESS_KEY=...");
      console.error("2. Configure AWS CLI:");
      console.error("   aws configure");
      console.error("3. Use an AWS profile:");
      console.error("   export AWS_PROFILE=your-profile\n");
    }

    process.exit(1);
  }
}

setupControlPlaneUser();
