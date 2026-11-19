/**
 * How the dispatcher reads Lambda's answer to a job run's invoke. The
 * dispatcher's own tests replace `invoke` with a fake, so these cases pin the
 * mapping from the SDK's answers to the outcomes the dispatcher records: a
 * throttle must read as "throttled", which records no failure.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mockClient } from "aws-sdk-client-mock";
import {
  InvokeCommand,
  LambdaClient,
  TooManyRequestsException,
  type InvokeCommandOutput,
} from "@aws-sdk/client-lambda";
import { __setLambdaClientForTests, dispatcherDeps } from "../src/api-handler.js";

const lambdaMock = mockClient(LambdaClient);
const context = {
  invokedFunctionArn: "arn:aws:lambda:us-east-1:123456789012:function:teststack-dispatcher",
};
const invoke = (event: unknown = { hello: "app" }) =>
  dispatcherDeps(context, []).invoke("teststack-app-probe-static", event, 60_000);
/** A response payload as the SDK types it; the handler reads only its bytes. */
const payload = (value: unknown) =>
  new TextEncoder().encode(JSON.stringify(value)) as unknown as InvokeCommandOutput["Payload"];

beforeEach(() => {
  lambdaMock.reset();
  __setLambdaClientForTests(null);
});
afterEach(() => __setLambdaClientForTests(null));

describe("invoking a job's function", () => {
  it("invokes the named function synchronously with the event", async () => {
    lambdaMock
      .on(InvokeCommand)
      .resolves({ StatusCode: 200, Payload: payload({ statusCode: 200 }) });
    await invoke({ rawPath: "/apps/probe/_starkeep/jobs/probe-tick" });
    const input = lambdaMock.commandCalls(InvokeCommand)[0]!.args[0].input;
    expect(input.FunctionName).toBe("teststack-app-probe-static");
    expect(input.InvocationType).toBe("RequestResponse");
    expect(JSON.parse(Buffer.from(input.Payload as Uint8Array).toString("utf8"))).toEqual({
      rawPath: "/apps/probe/_starkeep/jobs/probe-tick",
    });
  });

  it("reads the app's HTTP answer", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      Payload: payload({ statusCode: 502, body: '{"message":"Peloton said no"}' }),
    });
    expect(await invoke()).toEqual({
      kind: "answered",
      statusCode: 502,
      body: '{"message":"Peloton said no"}',
    });
  });

  it("reads a function error's message", async () => {
    lambdaMock.on(InvokeCommand).resolves({
      StatusCode: 200,
      FunctionError: "Unhandled",
      Payload: payload({ errorType: "Sandbox.Timedout", errorMessage: "Task timed out" }),
    });
    expect(await invoke()).toEqual({ kind: "function-error", message: "Task timed out" });
  });

  it("calls an answer with no status code a function error", async () => {
    lambdaMock.on(InvokeCommand).resolves({ StatusCode: 200, Payload: payload({ ok: true }) });
    expect(await invoke()).toEqual({
      kind: "function-error",
      message: "the function returned no HTTP response",
    });
  });

  it("reads Lambda's concurrency refusal as a throttle, not a failure", async () => {
    lambdaMock
      .on(InvokeCommand)
      .rejects(new TooManyRequestsException({ message: "Rate exceeded", $metadata: {} }));
    expect(await invoke()).toEqual({ kind: "throttled" });
  });

  it("reads any other refusal as an invoke error", async () => {
    lambdaMock.on(InvokeCommand).rejects(new Error("Function not found"));
    expect(await invoke()).toEqual({ kind: "invoke-error", message: "Function not found" });
  });
});
