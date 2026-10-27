/**
 * Android Key Attestation: which app on which phone holds a key.
 *
 * A mobile app signs in through a public Cognito client, so a token alone
 * cannot say which app holds it: any code with the user's password could have
 * signed in. The phone proves the app instead. The app generates a signing key
 * in the Android Keystore, and the Keystore returns a certificate chain for it.
 * The chain ends at Google's hardware attestation root, and the leaf carries
 * the key description extension: the app's package name and signing
 * certificates, the device's boot state, and the challenge the app asked for.
 * The Keystore fills those in, not the app, so on a locked, verified device
 * the app cannot claim to be another.
 *
 * This module checks a chain and reads what it attests. It decides nothing
 * about grants; the broker maps the attested identity to an app and stores the
 * key (`api-handler.ts`, the mobile key route).
 */
import { X509Certificate, createHash, createPublicKey } from "node:crypto";
import {
  NonStandardKeyDescription,
  AttestationApplicationId,
  SecurityLevel,
  VerifiedBootState,
  id_ce_keyDescription,
} from "@peculiar/asn1-android";
import { AsnConvert } from "@peculiar/asn1-schema";
import { Certificate } from "@peculiar/asn1-x509";

/** What an accepted chain attests about its key. */
export interface AttestedKey {
  /** SHA-256 of the key's SubjectPublicKeyInfo, as hex: the key's id. */
  readonly keyId: string;
  /** The key's SubjectPublicKeyInfo, DER, base64. */
  readonly publicKey: string;
  /** The calling app's package name, as the OS reported it. */
  readonly packageName: string;
  /** SHA-256 digests of the app's signing certificates, lowercase hex. */
  readonly signingCertDigests: readonly string[];
  readonly securityLevel: "tee" | "strongbox";
}

export type AttestationResult =
  | { readonly ok: true; readonly key: AttestedKey }
  | { readonly ok: false; readonly reason: string };

export interface AttestationPolicy {
  /** Trusted roots, PEM. */
  readonly roots: readonly string[];
  /** Whether a certificate serial (lowercase hex, no leading zeros) is revoked or suspended. */
  readonly isRevoked: (serial: string) => boolean;
  readonly now?: Date;
}

/** KeyMint's `KeyPurpose.SIGN`. */
const PURPOSE_SIGN = 2;
/** KeyMint's `Algorithm.EC`. */
const ALGORITHM_EC = 3;
/** KeyMint's `KeyOrigin.GENERATED`: made inside the secure hardware, never imported. */
const ORIGIN_GENERATED = 0;

/** A certificate serial as Google's revocation list keys it. */
export function normalizeSerial(serial: string): string {
  return serial.toLowerCase().replace(/^0+(?=.)/, "");
}

/**
 * The bytes of an ASN.1 OCTET STRING as the schemas hand it back: an
 * `OctetString` where a schema names the class, a bare `ArrayBuffer` where it
 * names the primitive type, as `AttestationApplicationId` does.
 */
function bytes(value: unknown): Buffer {
  if (value instanceof ArrayBuffer) return Buffer.from(value);
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  const inner = (value as { buffer?: unknown } | null)?.buffer;
  if (inner instanceof ArrayBuffer) return Buffer.from(inner);
  throw new Error("not an octet string");
}

function refuse(reason: string): AttestationResult {
  return { ok: false, reason };
}

/**
 * Check a chain, leaf first, against Google's roots and the expected
 * challenge, and return the attested key.
 *
 * Refused: a chain that does not end at a pinned root, a broken signature, an
 * expired or revoked certificate, a key made in software, a key imported
 * rather than generated, a key that is not EC P-256 for signing, an unlocked
 * or unverified device, a challenge other than the expected one, and an
 * attested application that names more or fewer than one package.
 */
export function verifyAttestation(
  chainDer: readonly Buffer[],
  expectedChallenge: Buffer,
  policy: AttestationPolicy,
): AttestationResult {
  if (chainDer.length < 2 || chainDer.length > 10) {
    return refuse("The attestation chain must hold between 2 and 10 certificates");
  }
  let chain: X509Certificate[];
  try {
    chain = chainDer.map((der) => new X509Certificate(der));
  } catch {
    return refuse("The attestation chain holds a certificate that does not parse");
  }
  const now = policy.now ?? new Date();
  const roots = policy.roots.map((pem) => new X509Certificate(pem));

  // Each certificate is signed by the next one.
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i]!.verify(chain[i + 1]!.publicKey)) {
      return refuse(`Certificate ${i} of the chain is not signed by certificate ${i + 1}`);
    }
  }
  // The chain ends at a pinned root: either the root itself, or a certificate
  // a pinned root signed.
  const last = chain[chain.length - 1]!;
  const anchored = roots.some((root) => last.verify(root.publicKey));
  if (!anchored) return refuse("The attestation chain does not end at a Google root");

  // Every certificate above the leaf must be in date. The leaf's dates are
  // the key's own validity, which the app chose, and say nothing about trust.
  for (const cert of chain.slice(1)) {
    if (new Date(cert.validFrom) > now || new Date(cert.validTo) < now) {
      return refuse("A certificate in the attestation chain is out of date");
    }
  }
  for (const cert of chain) {
    if (policy.isRevoked(normalizeSerial(cert.serialNumber))) {
      return refuse("A certificate in the attestation chain is revoked");
    }
  }

  // The key description, from the leaf.
  let description: NonStandardKeyDescription;
  try {
    const leaf = AsnConvert.parse(chainDer[0]!, Certificate);
    const extension = leaf.tbsCertificate.extensions?.find(
      (e) => e.extnID === id_ce_keyDescription,
    );
    if (!extension) return refuse("The leaf certificate carries no key description");
    description = AsnConvert.parse(extension.extnValue.buffer, NonStandardKeyDescription);
  } catch {
    return refuse("The leaf certificate's key description does not parse");
  }

  const levels = [description.attestationSecurityLevel, description.keymasterSecurityLevel];
  if (levels.some((l) => l !== SecurityLevel.trustedEnvironment && l !== SecurityLevel.strongBox)) {
    return refuse("The key was not made in secure hardware");
  }
  const challenge = bytes(description.attestationChallenge);
  if (!challenge.equals(expectedChallenge)) {
    return refuse("The attestation was made for another sign-in");
  }

  // Hardware-enforced properties only: the software list is the OS's word,
  // which an unlocked device can make say anything.
  const hw = description.teeEnforced;
  const rootOfTrust = hw.findProperty("rootOfTrust");
  if (!rootOfTrust) return refuse("The attestation reports no boot state");
  if (
    rootOfTrust.verifiedBootState !== VerifiedBootState.verified &&
    rootOfTrust.verifiedBootState !== VerifiedBootState.selfSigned
  ) {
    return refuse("The device's operating system is not verified");
  }
  if (!rootOfTrust.deviceLocked) return refuse("The device's bootloader is unlocked");
  if (hw.findProperty("origin") !== ORIGIN_GENERATED) {
    return refuse("The key was imported, not generated in secure hardware");
  }
  if (hw.findProperty("algorithm") !== ALGORITHM_EC) return refuse("The key is not an EC key");
  if (!(hw.findProperty("purpose") ?? []).includes(PURPOSE_SIGN)) {
    return refuse("The key may not sign");
  }
  const leafKey = chain[0]!.publicKey;
  if (
    leafKey.asymmetricKeyType !== "ec" ||
    leafKey.asymmetricKeyDetails?.namedCurve !== "prime256v1"
  ) {
    return refuse("The key is not on P-256");
  }

  // The calling app. The OS fills this in from the package manager, so it is
  // in the software list by design; the boot checks above are what make it
  // trustworthy.
  const appIdBytes = description.softwareEnforced.findProperty("attestationApplicationId");
  if (!appIdBytes) return refuse("The attestation names no application");
  let appId: AttestationApplicationId;
  try {
    appId = AsnConvert.parse(bytes(appIdBytes), AttestationApplicationId);
  } catch {
    return refuse("The attested application does not parse");
  }
  // Apps that share a user id share an attestation. Which of them asked is
  // then unknowable, so none of them is accepted.
  if (appId.packageInfos.length !== 1) {
    return refuse("The attestation names more than one package");
  }
  const packageName = bytes(appId.packageInfos[0]!.packageName).toString("utf8");
  const signingCertDigests = appId.signatureDigests.map((d) => bytes(d).toString("hex"));
  if (signingCertDigests.length === 0)
    return refuse("The attestation names no signing certificate");

  const spki = leafKey.export({ type: "spki", format: "der" });
  return {
    ok: true,
    key: {
      keyId: createHash("sha256").update(spki).digest("hex"),
      publicKey: spki.toString("base64"),
      packageName,
      signingCertDigests,
      securityLevel:
        description.attestationSecurityLevel === SecurityLevel.strongBox ? "strongbox" : "tee",
    },
  };
}

/** An installed app's Android build, as its manifest declared it. */
export interface MobileIdentity {
  readonly appId: string;
  readonly androidPackage: string;
  readonly certDigests: readonly string[];
}

/**
 * The one installed app an attested key speaks for, or null.
 *
 * The package must match, and every certificate the app is signed with must be
 * one the manifest lists. More than one match is refused: two installs
 * claiming one build would let either one's grants apply.
 */
export function appForAttestedKey(
  key: AttestedKey,
  identities: readonly MobileIdentity[],
): string | null {
  const matches = identities.filter(
    (id) =>
      id.androidPackage === key.packageName &&
      key.signingCertDigests.every((d) => id.certDigests.includes(d)),
  );
  return matches.length === 1 ? matches[0]!.appId : null;
}

/** A public key from its stored form, for verifying a request's signature. */
export function publicKeyFrom(stored: string) {
  return createPublicKey({ key: Buffer.from(stored, "base64"), format: "der", type: "spki" });
}
