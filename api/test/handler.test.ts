import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { handler } from "../src/handler";

function eventFor(method: string, rawPath: string): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: "",
    headers: {
      host: "example.com",
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "example.com",
      domainPrefix: "example",
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "node-test",
      },
      requestId: "request-id",
      routeKey: `${method} ${rawPath}`,
      stage: "$default",
      time: "27/Aug/2026:10:00:00 +0000",
      timeEpoch: 1787824800000,
    },
    isBase64Encoded: false,
  };
}

describe("handler", () => {
  it("returns generic content for GET /content", async () => {
    process.env.CONTENT_VERSION = "starter";

    const response = await handler(eventFor("GET", "/content"));

    assert.equal(response.statusCode, 200);
    assert.equal(response.headers?.["content-type"], "application/json");
    assert.deepEqual(JSON.parse(response.body ?? "{}"), {
      message: "Hello from an AWS Lambda API.",
      content: "This is generic workshop content.",
      version: "starter",
    });
  });

  it("returns 404 for unsupported routes", async () => {
    const response = await handler(eventFor("GET", "/unknown"));

    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body ?? "{}"), {
      error: "Not found",
    });
  });

  it("returns 404 for unsupported methods", async () => {
    const response = await handler(eventFor("POST", "/content"));

    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body ?? "{}"), {
      error: "Not found",
    });
  });
});
