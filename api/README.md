# AWS Lambda x402 Paywall

This directory contains the seller API used in the AWS and Stripe Machine Payments Workshop.
The workshop starts by building and monetizing this API, then continues with an Amazon Bedrock
AgentCore buyer that pays it autonomously.

You begin with a public endpoint that returns JSON without authentication or payment:

```text
GET /content -> HTTP 200
```

You then place the same endpoint behind an x402 payment boundary:

```text
GET /content without payment -> HTTP 402 + PAYMENT-REQUIRED
GET /content with payment    -> HTTP 200 + PAYMENT-RESPONSE + content
```

The paid version uses `mppx` to produce and verify the x402 exchange, an x402 facilitator to settle Base USDC, and a Stripe-managed deposit address to record the successful payment.

## Project structure

```text
src/handler.ts                 Free API handler
src/http-adapters.ts           API Gateway/Web API adapters
src/mpp-handler.solution.ts    Completed paywall reference
lib/api-stack.ts               Lambda and API Gateway CDK stack
test/                          Starter API and adapter tests
../workshop/                   Sequential participant instructions
```

The free and paid handlers are separate entry points. Running `npm run deploy` deploys the free API. Running `npm run deploy:mpp` deploys the paywall you create during the workshop.

## Technology

- TypeScript and Node.js 24 on AWS Lambda
- API Gateway HTTP API
- AWS CDK v2
- `mppx` with x402 v2
- Stripe machine payments
- Base Sepolia USDC for sandbox testing

## Workshop chapters

The step-by-step instructions for this API are in the workshop guide on AWS Workshop Studio,
under **Phase 1: Build the seller**. See the [repository README](../README.md) for the link.
