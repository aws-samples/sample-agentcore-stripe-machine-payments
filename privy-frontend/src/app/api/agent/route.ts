// Chat with the agent deployed to Amazon Bedrock AgentCore Runtime.
//
// The browser never talks to AWS. It sends its Privy access token and a
// prompt here; this route checks the token, calls InvokeAgentRuntime with the
// server's AWS credentials (the IDE role in the workshop), and streams back
// one JSON object per line:
//
//   {"type":"text","text":"..."}      model output, token by token
//   {"type":"trace","step":{...}}     tool calls and payments from payment_trace.py
//   {"type":"ping"}                   keep-alive while the agent is busy
//   {"type":"error","message":"..."}
//   {"type":"done"}
import { readFile } from "node:fs/promises";
import path from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  CloudFormationClient,
  DescribeStacksCommand,
} from "@aws-sdk/client-cloudformation";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const MAX_PROMPT_LENGTH = 2000;
// InvokeAgentRuntime requires session IDs of at least 33 characters.
const SESSION_ID_PATTERN = /^[A-Za-z0-9-]{33,100}$/;
// CloudFront closes an origin connection that is silent for 30 seconds, and a
// cold runtime or a payment round trip can take that long before any output.
const KEEPALIVE_MS = 10_000;

const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
const jwks = appId
  ? createRemoteJWKSet(
      new URL(`https://auth.privy.io/api/v1/apps/${appId}/jwks.json`),
    )
  : null;

async function isAuthenticated(req: NextRequest): Promise<boolean> {
  const token = req.headers.get("authorization")?.replace(/^Bearer /, "");
  if (!token || !jwks || !appId) return false;
  try {
    await jwtVerify(token, jwks, { issuer: "privy.io", audience: appId });
    return true;
  } catch {
    return false;
  }
}

// The runtime ARN comes from AGENT_RUNTIME_ARN if set, otherwise from the
// state file `agentcore deploy` writes, so a redeploy needs no restart here.
async function resolveRuntimeArn(): Promise<string | null> {
  if (process.env.AGENT_RUNTIME_ARN) return process.env.AGENT_RUNTIME_ARN;
  try {
    const statePath = path.resolve(
      process.cwd(),
      "../agentcore/.cli/deployed-state.json",
    );
    const state = JSON.parse(await readFile(statePath, "utf8")) as {
      targets?: Record<
        string,
        { resources?: { runtimes?: Record<string, { runtimeArn?: string }> } }
      >;
    };
    for (const target of Object.values(state.targets ?? {})) {
      for (const rt of Object.values(target.resources?.runtimes ?? {})) {
        if (rt.runtimeArn) return rt.runtimeArn;
      }
    }
  } catch {
    // Not deployed yet.
  }
  return null;
}

// The seller API from the first phase, used to pre-fill a suggested prompt.
async function resolvePaidApiUrl(region: string): Promise<string | null> {
  try {
    const res = await new CloudFormationClient({ region }).send(
      new DescribeStacksCommand({ StackName: "WorkshopApiStack" }),
    );
    const output = res.Stacks?.[0]?.Outputs?.find((o) => o.OutputKey === "ApiUrl");
    return output?.OutputValue ?? null;
  } catch {
    return null;
  }
}

export async function GET() {
  const arn = await resolveRuntimeArn();
  const region = arn?.split(":")[3] ?? process.env.AWS_REGION ?? "us-east-1";
  return NextResponse.json({
    configured: Boolean(arn),
    runtimeName: arn?.split("/").pop() ?? null,
    apiUrl: await resolvePaidApiUrl(region),
  });
}

export async function POST(req: NextRequest) {
  if (!(await isAuthenticated(req))) {
    return NextResponse.json({ error: "Sign in again." }, { status: 401 });
  }

  const body = (await req.json().catch(() => null)) as {
    prompt?: unknown;
    sessionId?: unknown;
  } | null;
  const prompt = typeof body?.prompt === "string" ? body.prompt.trim() : "";
  const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
  if (!prompt || prompt.length > MAX_PROMPT_LENGTH) {
    return NextResponse.json(
      { error: `The prompt must be 1 to ${MAX_PROMPT_LENGTH} characters.` },
      { status: 400 },
    );
  }
  if (!SESSION_ID_PATTERN.test(sessionId)) {
    return NextResponse.json({ error: "Invalid session ID." }, { status: 400 });
  }

  const runtimeArn = await resolveRuntimeArn();
  if (!runtimeArn) {
    return NextResponse.json(
      { error: "No deployed agent found. Run `agentcore deploy` first." },
      { status: 503 },
    );
  }
  const region = runtimeArn.split(":")[3];
  const client = new BedrockAgentCoreClient({ region });
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (obj: unknown) =>
        controller.enqueue(encoder.encode(JSON.stringify(obj) + "\n"));
      const keepalive = setInterval(() => send({ type: "ping" }), KEEPALIVE_MS);
      send({ type: "ping" });

      try {
        const res = await client.send(
          new InvokeAgentRuntimeCommand({
            agentRuntimeArn: runtimeArn,
            runtimeSessionId: sessionId,
            contentType: "application/json",
            accept: "text/event-stream",
            // Only a plain string prompt is forwarded, never raw messages, so
            // a caller cannot inject tool calls into the agent.
            payload: encoder.encode(JSON.stringify({ prompt })),
          }),
        );
        if (!res.response) throw new Error("Empty response from the runtime.");

        const reader = res.response.transformToWebStream().getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let newline: number;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (!line.startsWith("data:")) continue;
            let data: {
              trace?: unknown;
              error?: unknown;
              event?: { contentBlockDelta?: { delta?: { text?: string } } };
            };
            try {
              data = JSON.parse(line.slice(5).trim());
            } catch {
              continue;
            }
            if (data.trace) send({ type: "trace", step: data.trace });
            else if (data.error) send({ type: "error", message: String(data.error) });
            else {
              const text = data.event?.contentBlockDelta?.delta?.text;
              if (text) send({ type: "text", text });
            }
          }
        }
        send({ type: "done" });
      } catch (err) {
        send({
          type: "error",
          message: err instanceof Error ? err.message : "Agent invocation failed.",
        });
      } finally {
        clearInterval(keepalive);
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "application/x-ndjson; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      "X-Accel-Buffering": "no",
    },
  });
}
