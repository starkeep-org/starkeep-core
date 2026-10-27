/**
 * Android Key Attestation chains for tests: a test root, an intermediate and a
 * leaf whose key description says what the case needs it to say.
 *
 * Built with the same ASN.1 schemas the verifier parses with, and signed with
 * real ECDSA, so a chain the verifier accepts here differs from a phone's only
 * in which root it ends at.
 */
import { createHash, generateKeyPairSync, sign, type KeyObject } from "node:crypto";
import {
  AttestationApplicationId,
  AttestationPackageInfo,
  AuthorizationList,
  IntegerSet,
  KeyDescription,
  RootOfTrust,
  SecurityLevel,
  VerifiedBootState,
  id_ce_keyDescription,
} from "@peculiar/asn1-android";
import { AsnConvert, OctetString } from "@peculiar/asn1-schema";
import {
  AlgorithmIdentifier,
  AttributeTypeAndValue,
  AttributeValue,
  Certificate,
  Extension,
  Extensions,
  Name,
  RelativeDistinguishedName,
  SubjectPublicKeyInfo,
  TBSCertificate,
  Validity,
  Version,
} from "@peculiar/asn1-x509";

const ECDSA_WITH_SHA256 = "1.2.840.10045.4.3.2";
const COMMON_NAME = "2.5.4.3";

export interface KeyPair {
  publicKey: KeyObject;
  privateKey: KeyObject;
}

function name(cn: string): Name {
  return new Name([
    new RelativeDistinguishedName([
      new AttributeTypeAndValue({
        type: COMMON_NAME,
        value: new AttributeValue({ utf8String: cn }),
      }),
    ]),
  ]);
}

function certificate(args: {
  subject: string;
  issuer: string;
  subjectKey: KeyObject;
  issuerKey: KeyObject;
  serial: number;
  notBefore?: Date;
  notAfter?: Date;
  extensions?: Extension[];
}): Buffer {
  const signatureAlgorithm = new AlgorithmIdentifier({ algorithm: ECDSA_WITH_SHA256 });
  const tbs = new TBSCertificate({
    version: Version.v3,
    serialNumber: new Uint8Array([args.serial]).buffer,
    signature: signatureAlgorithm,
    issuer: name(args.issuer),
    validity: new Validity({
      notBefore: args.notBefore ?? new Date("2020-01-01T00:00:00Z"),
      notAfter: args.notAfter ?? new Date("2045-01-01T00:00:00Z"),
    }),
    subject: name(args.subject),
    subjectPublicKeyInfo: AsnConvert.parse(
      args.subjectKey.export({ type: "spki", format: "der" }),
      SubjectPublicKeyInfo,
    ),
    ...(args.extensions ? { extensions: new Extensions(args.extensions) } : {}),
  });
  const tbsDer = Buffer.from(AsnConvert.serialize(tbs));
  const signature = sign("sha256", tbsDer, args.issuerKey);
  const cert = new Certificate({
    tbsCertificate: tbs,
    signatureAlgorithm,
    signatureValue: new Uint8Array(signature).buffer,
  });
  return Buffer.from(AsnConvert.serialize(cert));
}

export function ecKeyPair(curve = "prime256v1"): KeyPair {
  return generateKeyPairSync("ec", { namedCurve: curve });
}

/** What the leaf's key description attests. Every field defaults to an acceptable value. */
export interface LeafClaims {
  challenge: Buffer;
  packageName?: string;
  /** The app's signing-certificate digests, hex. */
  certDigests?: string[];
  /** Extra packages sharing the app's user id. */
  extraPackages?: string[];
  securityLevel?: SecurityLevel;
  bootState?: VerifiedBootState;
  deviceLocked?: boolean;
  origin?: number;
  purposes?: number[];
  /** The key the leaf certifies. Defaults to a fresh P-256 key. */
  key?: KeyPair;
}

export const TEST_PACKAGE = "app.starkeep.photos";
export const TEST_CERT_DIGEST = createHash("sha256").update("test signing cert").digest("hex");

export interface TestAuthority {
  /** The root's certificate, PEM: what a policy pins. */
  rootPem: string;
  /** A chain, leaf first, for the claims given. */
  chain(claims: LeafClaims): { chain: Buffer[]; key: KeyPair; serials: string[] };
}

/** A root and an intermediate that every chain from this authority shares. */
export function testAuthority(rootName = "Test Attestation Root"): TestAuthority {
  const root = ecKeyPair("secp384r1");
  const intermediate = ecKeyPair();
  const rootDer = certificate({
    subject: rootName,
    issuer: rootName,
    subjectKey: root.publicKey,
    issuerKey: root.privateKey,
    serial: 1,
  });
  const intermediateDer = certificate({
    subject: "Test Attestation Intermediate",
    issuer: rootName,
    subjectKey: intermediate.publicKey,
    issuerKey: root.privateKey,
    serial: 2,
  });
  const rootPem = `-----BEGIN CERTIFICATE-----\n${rootDer
    .toString("base64")
    .replace(/(.{64})/g, "$1\n")
    .trim()}\n-----END CERTIFICATE-----\n`;

  return {
    rootPem,
    chain(claims) {
      const key = claims.key ?? ecKeyPair();
      const appId = new AttestationApplicationId({
        packageInfos: [claims.packageName ?? TEST_PACKAGE, ...(claims.extraPackages ?? [])].map(
          (p) =>
            new AttestationPackageInfo({
              packageName: new OctetString(Buffer.from(p, "utf8")),
              version: 1,
            }),
        ),
        signatureDigests: (claims.certDigests ?? [TEST_CERT_DIGEST]).map(
          (d) => new OctetString(Buffer.from(d, "hex")),
        ),
      });
      const level = claims.securityLevel ?? SecurityLevel.trustedEnvironment;
      const description = new KeyDescription({
        attestationVersion: 200,
        attestationSecurityLevel: level,
        keymasterVersion: 200,
        keymasterSecurityLevel: level,
        attestationChallenge: new OctetString(claims.challenge),
        uniqueId: new OctetString(Buffer.alloc(0)),
        softwareEnforced: new AuthorizationList({
          attestationApplicationId: new OctetString(AsnConvert.serialize(appId)),
        }),
        teeEnforced: new AuthorizationList({
          purpose: new IntegerSet(claims.purposes ?? [2]),
          algorithm: 3,
          keySize: 256,
          ecCurve: 1,
          origin: claims.origin ?? 0,
          rootOfTrust: new RootOfTrust({
            verifiedBootKey: new OctetString(Buffer.alloc(32, 1)),
            deviceLocked: claims.deviceLocked ?? true,
            verifiedBootState: claims.bootState ?? VerifiedBootState.verified,
          }),
        }),
      });
      const leaf = certificate({
        subject: "Android Keystore Key",
        issuer: "Test Attestation Intermediate",
        subjectKey: key.publicKey,
        issuerKey: intermediate.privateKey,
        serial: 3,
        extensions: [
          new Extension({
            extnID: id_ce_keyDescription,
            critical: false,
            extnValue: new OctetString(AsnConvert.serialize(description)),
          }),
        ],
      });
      return { chain: [leaf, intermediateDer, rootDer], key, serials: ["3", "2", "1"] };
    },
  };
}
