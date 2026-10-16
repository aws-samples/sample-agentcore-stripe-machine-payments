import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

type JsonValue = Record<string, unknown>;

export function jsonResponse(
  statusCode: number,
  body: JsonValue,
): APIGatewayProxyStructuredResultV2 {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
}

export async function buildContentResponse(): Promise<APIGatewayProxyStructuredResultV2> {
  return jsonResponse(200, {
    message: "Hello from an AWS Lambda API.",
    content: "This is generic workshop content.",
    version: process.env.CONTENT_VERSION ?? "starter",
  });
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  console.log(
    JSON.stringify({
      method,
      path,
      route: "content",
      mpp: "not_configured",
    }),
  );

  if (method !== "GET" || path !== "/content") {
    return jsonResponse(404, { error: "Not found" });
  }

  // Keep this starter handler free and unchanged. The workshop adds the
  // x402 paywall in a separate `src/mpp-handler.ts` entry point.
  return buildContentResponse();
}
