import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";

const METHODS_WITHOUT_BODY = new Set(["GET", "HEAD"]);

export function apiGatewayEventToRequest(event: APIGatewayProxyEventV2): Request {
  const method = event.requestContext.http.method;
  const headers = new Headers();

  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (value !== undefined) {
      headers.set(name, value);
    }
  }

  const forwardedProto = headers.get("x-forwarded-proto");
  const protocol = forwardedProto ?? "https";
  const host = headers.get("host") ?? event.requestContext.domainName;
  const queryString = event.rawQueryString ? `?${event.rawQueryString}` : "";
  const url = `${protocol}://${host}${event.rawPath}${queryString}`;

  const init: RequestInit = {
    headers,
    method,
  };

  if (event.body && !METHODS_WITHOUT_BODY.has(method.toUpperCase())) {
    init.body = event.isBase64Encoded
      ? Buffer.from(event.body, "base64")
      : event.body;
  }

  return new Request(url, init);
}

export async function webResponseToApiGatewayResponse(
  response: Response,
): Promise<APIGatewayProxyStructuredResultV2> {
  const headers: Record<string, string> = {};

  response.headers.forEach((value, name) => {
    headers[name] = value;
  });

  return {
    statusCode: response.status,
    headers,
    body: await response.text(),
  };
}
