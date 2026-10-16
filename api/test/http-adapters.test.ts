import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import {
  apiGatewayEventToRequest,
  webResponseToApiGatewayResponse,
} from "../src/http-adapters";

function eventFor(
  overrides: Partial<APIGatewayProxyEventV2> = {},
): APIGatewayProxyEventV2 {
  const method = overrides.requestContext?.http.method ?? "GET";
  const rawPath = overrides.rawPath ?? "/content";

  return {
    version: "2.0",
    routeKey: `${method} ${rawPath}`,
    rawPath,
    rawQueryString: overrides.rawQueryString ?? "",
    headers: {
      host: "api.example.com",
      "x-forwarded-proto": "https",
      ...overrides.headers,
    },
    requestContext: {
      accountId: "123456789012",
      apiId: "api-id",
      domainName: "api.example.com",
      domainPrefix: "api",
      http: {
        method,
        path: rawPath,
        protocol: "HTTP/1.1",
        sourceIp: "127.0.0.1",
        userAgent: "node-test",
        ...overrides.requestContext?.http,
      },
      requestId: "request-id",
      routeKey: `${method} ${rawPath}`,
      stage: "$default",
      time: "27/Aug/2026:10:00:00 +0000",
      timeEpoch: 1787824800000,
      ...overrides.requestContext,
    },
    isBase64Encoded: overrides.isBase64Encoded ?? false,
    body: overrides.body,
    ...overrides,
  };
}

describe("apiGatewayEventToRequest", () => {
  it("builds a Web Request from an API Gateway HTTP API event", async () => {
    const request = apiGatewayEventToRequest(
      eventFor({
        rawQueryString: "format=json",
        headers: {
          authorization: "Payment example",
          "payment-signature": "x402-example",
        },
      }),
    );

    assert.equal(request.method, "GET");
    assert.equal(request.url, "https://api.example.com/content?format=json");
    assert.equal(request.headers.get("authorization"), "Payment example");
    assert.equal(request.headers.get("payment-signature"), "x402-example");
  });

  it("copies a non-GET body", async () => {
    const request = apiGatewayEventToRequest(
      eventFor({
        body: JSON.stringify({ example: true }),
        headers: {
          "content-type": "application/json",
        },
        requestContext: {
          http: {
            method: "POST",
            path: "/content",
            protocol: "HTTP/1.1",
            sourceIp: "127.0.0.1",
            userAgent: "node-test",
          },
        } as APIGatewayProxyEventV2["requestContext"],
      }),
    );

    assert.equal(await request.text(), JSON.stringify({ example: true }));
  });
});

describe("webResponseToApiGatewayResponse", () => {
  it("copies status, headers, and body from a Web Response", async () => {
    const response = await webResponseToApiGatewayResponse(
      new Response(JSON.stringify({ ok: true }), {
        status: 402,
        headers: {
          "content-type": "application/json",
          "payment-required": "x402-requirements",
          "www-authenticate": "Payment example",
        },
      }),
    );

    assert.equal(response.statusCode, 402);
    assert.equal(response.headers?.["content-type"], "application/json");
    assert.equal(
      response.headers?.["payment-required"],
      "x402-requirements",
    );
    assert.equal(response.headers?.["www-authenticate"], "Payment example");
    assert.deepEqual(JSON.parse(response.body ?? "{}"), { ok: true });
  });
});
