import type {
  APIGatewayProxyEventV2,
  APIGatewayProxyStructuredResultV2,
} from "aws-lambda";
import { Mppx, stripe as stripeMpp } from "mppx/server";
import Stripe from "stripe";
import {
  apiGatewayEventToRequest,
  webResponseToApiGatewayResponse,
} from "./http-adapters";
import { jsonResponse } from "./handler";

type PaymentResult =
  | {
      challenge: Response;
      status: 402;
    }
  | {
      status: 200;
      withReceipt: (response: Response) => Response;
    };

type PaymentHandler = (request: Request) => Promise<PaymentResult>;

let cachedPaymentHandler: Promise<PaymentHandler> | undefined;

function requiredEnv(name: string): string {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value;
}

async function paymentHandler(): Promise<PaymentHandler> {
  if (cachedPaymentHandler) {
    return cachedPaymentHandler;
  }

  cachedPaymentHandler = (async () => {
    const stripeClient = new Stripe(requiredEnv("STRIPE_SECRET_KEY"));

    const machinePayments = stripeMpp.create({
      client: stripeClient,
      depositAddresses: (network) =>
        stripeMpp.findOrCreateDepositAddress(stripeClient, network),
      livemode: process.env.STRIPE_LIVEMODE === "true",
      networkId: requiredEnv("STRIPE_PROFILE_ID"),
    });

    const recipient = await machinePayments.findOrCreateDepositAddress("base");

    const mppx = Mppx.create({
      methods: [
        machinePayments.base.charge({
          recipient,
          x402: {
            facilitator: requiredEnv("X402_FACILITATOR_URL"),
          },
        }),
      ],
      realm: process.env.MPP_REALM,
      secretKey: requiredEnv("MPP_SECRET_KEY"),
    });

    return mppx.evm.charge({
      amount: process.env.MPP_AMOUNT ?? "0.01",
      description: "Access the workshop content API",
      scope: "GET /content",
    });
  })();

  return cachedPaymentHandler;
}

function buildPaidContentResponse(): Response {
  return Response.json({
    message: "Hello from an AWS Lambda API.",
    content: "This is generic workshop content.",
    version: "x402-enabled",
  });
}

export async function handler(
  event: APIGatewayProxyEventV2,
): Promise<APIGatewayProxyStructuredResultV2> {
  const method = event.requestContext.http.method;
  const path = event.rawPath;

  if (method !== "GET" || path !== "/content") {
    return jsonResponse(404, { error: "Not found" });
  }

  const request = apiGatewayEventToRequest(event);
  const payment = await (await paymentHandler())(request);

  console.log(
    JSON.stringify({
      method,
      path,
      route: "content",
      mpp: payment.status === 402 ? "challenge" : "paid",
    }),
  );

  if (payment.status === 402) {
    return webResponseToApiGatewayResponse(payment.challenge);
  }

  return webResponseToApiGatewayResponse(
    payment.withReceipt(buildPaidContentResponse()),
  );
}
