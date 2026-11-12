export const handler = async (event) => ({
  statusCode: 200,
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    ok: true,
    from: "control",
    rawPath: event.rawPath,
    node: typeof process === "object" ? process.version : null,
  }),
});
