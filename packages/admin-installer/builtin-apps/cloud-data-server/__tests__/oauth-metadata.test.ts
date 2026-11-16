/**
 * The OAuth discovery documents: the protected resource metadata answers for
 * a declared delegated route only, through CloudFront only, and names the
 * host the client used; the authorization server metadata answers on the
 * issuer's host only and advertises what MCP clients look for.
 */
import { describe, expect, it } from "vitest";
import {
  declaresPath,
  handleOAuthMetadata,
  isOAuthMetadataPath,
  parseResource,
  type MetadataDeps,
} from "../src/oauth-metadata.js";

const ISSUER = "https://abc123.execute-api.us-east-1.amazonaws.com";

function deps(over: Partial<MetadataDeps> = {}): MetadataDeps {
  return {
    throughCloudFront: true,
    issuer: ISSUER,
    viewerBase: async () => "https://cloud.example.com",
    connectableApps: async () => [
      { appId: "probe", name: "Probe", delegatedPaths: ["/mcp", "/items/{id}"] },
    ],
    ...over,
  };
}

const PRM = "/.well-known/oauth-protected-resource/apps/probe/mcp";

describe("protected resource metadata", () => {
  it("names the resource on the viewer's host and the issuer", async () => {
    const res = await handleOAuthMetadata(PRM, deps());
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      resource: "https://cloud.example.com/apps/probe/mcp",
      authorization_servers: [ISSUER],
      scopes_supported: ["read"],
      bearer_methods_supported: ["header"],
      resource_name: "Probe",
    });
    expect(res.headers["Cache-Control"]).toBe("max-age=300");
    expect(res.headers["Access-Control-Allow-Origin"]).toBe("*");
  });

  it("follows the host the client used", async () => {
    const res = await handleOAuthMetadata(
      PRM,
      deps({ viewerBase: async () => "https://d111.cloudfront.net" }),
    );
    expect(JSON.parse(res.body).resource).toBe("https://d111.cloudfront.net/apps/probe/mcp");
  });

  it.each([
    ["an undeclared path", "/.well-known/oauth-protected-resource/apps/probe/api/echo"],
    ["a sub-path of a declared one", "/.well-known/oauth-protected-resource/apps/probe/mcp/x"],
    [
      "an app that serves no outside client",
      "/.well-known/oauth-protected-resource/apps/photos/mcp",
    ],
  ])("answers 404 for %s", async (_label, path) => {
    expect((await handleOAuthMetadata(path, deps())).statusCode).toBe(404);
  });

  it("answers 404 on the execute-api hostname", async () => {
    expect((await handleOAuthMetadata(PRM, deps({ throughCloudFront: false }))).statusCode).toBe(
      404,
    );
  });

  it("matches a declared parameter segment", async () => {
    const path = "/.well-known/oauth-protected-resource/apps/probe/items/42";
    expect((await handleOAuthMetadata(path, deps())).statusCode).toBe(200);
  });
});

describe("authorization server metadata", () => {
  it("advertises PKCE, CIMD, public clients and the iss parameter", async () => {
    const res = await handleOAuthMetadata(
      "/.well-known/oauth-authorization-server",
      deps({ throughCloudFront: false }),
    );
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual({
      issuer: ISSUER,
      authorization_endpoint: `${ISSUER}/connect/authorize`,
      token_endpoint: `${ISSUER}/connect/token`,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
      scopes_supported: ["read", "readwrite"],
    });
  });

  it("answers 404 through CloudFront, where the issuer would not match", async () => {
    const res = await handleOAuthMetadata("/.well-known/oauth-authorization-server", deps());
    expect(res.statusCode).toBe(404);
  });
});

describe("paths", () => {
  it("recognizes the two documents and nothing else", () => {
    expect(isOAuthMetadataPath("/.well-known/oauth-authorization-server")).toBe(true);
    expect(isOAuthMetadataPath(PRM)).toBe(true);
    expect(isOAuthMetadataPath("/.well-known/oauth-protected-resource")).toBe(false);
    expect(isOAuthMetadataPath("/.well-known/openid-configuration")).toBe(false);
  });

  it("matches declared paths segment by segment", () => {
    expect(declaresPath(["/mcp"], "/mcp")).toBe(true);
    expect(declaresPath(["/mcp"], "/mcp/")).toBe(false);
    expect(declaresPath(["/a/{id}"], "/a/1")).toBe(true);
    expect(declaresPath(["/a/{id}"], "/a/")).toBe(false);
    expect(declaresPath(["/a/{id}"], "/a/1/2")).toBe(false);
  });
});

describe("parseResource", () => {
  const hosts = ["cloud.example.com", "d111.cloudfront.net"];

  it("names the app and the path on one of the deployment's hosts", () => {
    expect(parseResource("https://cloud.example.com/apps/probe/mcp", hosts)).toEqual({
      appId: "probe",
      subPath: "/mcp",
      resource: "https://cloud.example.com/apps/probe/mcp",
    });
  });

  it.each([
    ["another host", "https://evil.example/apps/probe/mcp"],
    ["http", "http://cloud.example.com/apps/probe/mcp"],
    ["a query", "https://cloud.example.com/apps/probe/mcp?x=1"],
    ["a port", "https://cloud.example.com:444/apps/probe/mcp"],
    ["no app path", "https://cloud.example.com/mcp"],
    ["an odd spelling", "https://CLOUD.example.com/apps/probe/mcp"],
    ["nothing", undefined],
  ])("refuses %s", (_label, resource) => {
    expect(parseResource(resource, hosts)).toBeNull();
  });
});
