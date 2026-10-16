"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { usePrivy } from "@privy-io/react-auth";
import { mutate } from "swr";
import {
  Bot,
  CircleAlert,
  CircleCheck,
  ExternalLink,
  Globe,
  LoaderCircle,
  Lock,
  RotateCcw,
  Send,
  Wallet,
} from "lucide-react";

import { network } from "@/lib/network";

// One step reported by app/PaymentsAgent/payment_trace.py.
type TraceStep =
  | { type: "tool_call"; tool: string; method?: string; url?: string; withPayment?: boolean }
  | { type: "tool_result"; tool: string; statusCode?: number; status?: string }
  | {
      type: "payment_required";
      protocol?: string;
      amount?: number;
      currency?: string;
      recipient?: string;
      network?: string;
    }
  | { type: "payment_settled"; txHash?: string; amount?: number; currency?: string; network?: string }
  | { type: "payment_rejected"; detail?: string }
  | { type: "payment_failed"; error?: string; detail?: string };

type TurnItem = { kind: "text"; text: string } | { kind: "step"; step: TraceStep };

type Turn = {
  id: string;
  prompt: string;
  items: TurnItem[];
  status: "running" | "done" | "error";
  error?: string;
};

const TOOL_LABELS: Record<string, string> = {
  get_payment_session: "Checked the payment session budget",
  get_payment_instrument: "Looked up the wallet",
  list_payment_instruments: "Listed the wallets",
  get_payment_instrument_balance: "Checked the wallet balance",
};

const explorerUrl = network.base.chain.blockExplorers?.default.url ?? "https://sepolia.basescan.org";

function newSessionId(): string {
  // AgentCore Runtime session IDs must be at least 33 characters.
  return `${crypto.randomUUID()}-${crypto.randomUUID()}`.slice(0, 64);
}

function short(value: string | undefined, head = 6, tail = 4): string {
  if (!value) return "";
  return value.length > head + tail + 3 ? `${value.slice(0, head)}...${value.slice(-tail)}` : value;
}

function networkLabel(id: string | undefined): string {
  if (id === "eip155:84532") return "Base Sepolia";
  if (id === "eip155:8453") return "Base";
  return id ?? "";
}

function formatAmount(amount: number | undefined, currency = "USDC"): string {
  return amount === undefined ? "" : `${amount.toLocaleString("en-US", { maximumFractionDigits: 6 })} ${currency}`;
}

// Nova wraps its reasoning in <thinking> tags. Show it separately, muted, so
// the reply reads like the log of a local run without hiding the reasoning.
function splitThinking(text: string): { thinking: string[]; answer: string } {
  const thinking: string[] = [];
  let rest = text.replace(/<thinking>([\s\S]*?)(<\/thinking>|$)/g, (_, inner: string) => {
    if (inner.trim()) thinking.push(inner.trim());
    return "";
  });
  rest = rest.replace(/<\/?response>/g, "");
  return { thinking, answer: rest.trim() };
}

function StepRow({ step }: { step: TraceStep }) {
  const row = "flex items-start gap-2 text-sm";
  switch (step.type) {
    case "tool_call":
      if (step.tool !== "http_request") {
        return (
          <div className={`${row} text-[#64668b]`}>
            <Bot className="mt-0.5 size-4 shrink-0" />
            <span>{TOOL_LABELS[step.tool] ?? `Called ${step.tool}`}</span>
          </div>
        );
      }
      return (
        <div className={`${row} text-[#040217]`}>
          <Globe className="mt-0.5 size-4 shrink-0 text-[#64668b]" />
          <span className="min-w-0">
            {step.withPayment ? "Retrying with payment proof " : "Calling "}
            <code className="break-all rounded bg-[#f1f2f9] px-1.5 py-0.5 text-xs">
              {step.method} {step.url}
            </code>
          </span>
        </div>
      );
    case "payment_required":
      return (
        <div className={`${row} rounded-lg border border-[#fde68a] bg-[#fffbeb] px-3 py-2 text-[#92400e]`}>
          <Lock className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>402 Payment Required.</strong> The seller asks for{" "}
            <strong>{formatAmount(step.amount, step.currency)}</strong>
            {step.recipient ? ` to ${short(step.recipient)}` : ""}
            {step.network ? ` on ${networkLabel(step.network)}` : ""}
            {step.protocol ? ` (${step.protocol})` : ""}. AgentCore payments is signing it from your
            delegated wallet.
          </span>
        </div>
      );
    case "payment_settled":
      return (
        <div className={`${row} rounded-lg border border-[#87d7b7] bg-[#dcfce7] px-3 py-2 text-[#14532d]`}>
          <Wallet className="mt-0.5 size-4 shrink-0" />
          <span className="min-w-0">
            <strong>Paid {formatAmount(step.amount, step.currency)}</strong>
            {step.network ? ` on ${networkLabel(step.network)}` : ""}.{" "}
            {step.txHash && (
              <a
                href={`${explorerUrl}/tx/${step.txHash}`}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 break-all underline"
              >
                Transaction {short(step.txHash, 10, 8)}
                <ExternalLink className="size-3" />
              </a>
            )}
          </span>
        </div>
      );
    case "payment_rejected":
      return (
        <div className={`${row} rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[#991b1b]`}>
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>Payment rejected:</strong> {step.detail}
            {/underpriced|nonce/i.test(step.detail ?? "")
              ? " This is a temporary error from the public testnet facilitator, and your wallet was not charged. Send the prompt again."
              : ""}
          </span>
        </div>
      );
    case "payment_failed":
      return (
        <div className={`${row} rounded-lg border border-[#fecaca] bg-[#fef2f2] px-3 py-2 text-[#991b1b]`}>
          <CircleAlert className="mt-0.5 size-4 shrink-0" />
          <span>
            <strong>AgentCore payments could not pay.</strong> {step.detail}
            {/expired|not found/i.test(step.detail ?? "")
              ? " Create a new payment session, update agentcore.json and run agentcore deploy again."
              : ""}
          </span>
        </div>
      );
    case "tool_result":
      if (step.statusCode === undefined) return null;
      return (
        <div className={`${row} ${step.statusCode < 400 ? "text-[#16A34A]" : "text-[#991b1b]"}`}>
          <CircleCheck className="mt-0.5 size-4 shrink-0" />
          <span>
            HTTP {step.statusCode} {step.statusCode < 400 ? "content received" : "error"}
          </span>
        </div>
      );
  }
}

function TextBlock({ text }: { text: string }) {
  const { thinking, answer } = splitThinking(text);
  return (
    <div className="flex flex-col gap-2">
      {thinking.map((t, i) => (
        <p key={i} className="border-l-2 border-[#e2e3f0] pl-3 text-xs italic text-[#64668b]">
          {t}
        </p>
      ))}
      {answer && <p className="whitespace-pre-wrap text-sm text-[#040217]">{answer}</p>}
    </div>
  );
}

export function AgentChat() {
  const { getAccessToken } = usePrivy();
  const [turns, setTurns] = useState<Turn[]>([]);
  const [prompt, setPrompt] = useState("");
  const [sessionId, setSessionId] = useState(newSessionId);
  const [agent, setAgent] = useState<{ configured: boolean; runtimeName: string | null; apiUrl: string | null }>();
  const bottomRef = useRef<HTMLDivElement>(null);
  const busy = turns.some((t) => t.status === "running");

  useEffect(() => {
    fetch("/api/agent")
      .then((r) => r.json())
      .then(setAgent)
      .catch(() => setAgent({ configured: false, runtimeName: null, apiUrl: null }));
  }, []);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [turns]);

  const update = (id: string, fn: (t: Turn) => Turn) =>
    setTurns((all) => all.map((t) => (t.id === id ? fn(t) : t)));

  const append = (id: string, item: TurnItem) =>
    update(id, (t) => {
      const last = t.items[t.items.length - 1];
      if (item.kind === "text" && last?.kind === "text") {
        return { ...t, items: [...t.items.slice(0, -1), { kind: "text", text: last.text + item.text }] };
      }
      return { ...t, items: [...t.items, item] };
    });

  async function send(e?: FormEvent) {
    e?.preventDefault();
    const text = prompt.trim();
    if (!text || busy) return;
    const id = crypto.randomUUID();
    setTurns((all) => [...all, { id, prompt: text, items: [], status: "running" }]);
    setPrompt("");

    try {
      const token = await getAccessToken();
      const res = await fetch("/api/agent", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
        body: JSON.stringify({ prompt: text, sessionId }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        throw new Error(body.error ?? `Request failed with HTTP ${res.status}`);
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let finished = false;
      while (!finished) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let nl: number;
        while ((nl = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, nl);
          buffer = buffer.slice(nl + 1);
          if (!line.trim()) continue;
          const msg = JSON.parse(line) as
            | { type: "text"; text: string }
            | { type: "trace"; step: TraceStep }
            | { type: "error"; message: string }
            | { type: "done" }
            | { type: "ping" };
          if (msg.type === "text") append(id, { kind: "text", text: msg.text });
          else if (msg.type === "trace") {
            append(id, { kind: "step", step: msg.step });
            // Refresh the wallet card as soon as a payment settles.
            if (msg.step.type === "payment_settled") {
              void mutate((key) => typeof key === "string" && key.startsWith("/api/balances"));
            }
          } else if (msg.type === "error") throw new Error(msg.message);
          else if (msg.type === "done") finished = true;
        }
      }
      update(id, (t) => ({ ...t, status: "done" }));
      // The chain may confirm a few seconds after the receipt; refresh again.
      setTimeout(() => void mutate((key) => typeof key === "string" && key.startsWith("/api/balances")), 5000);
    } catch (err) {
      update(id, (t) => ({
        ...t,
        status: "error",
        error: err instanceof Error ? err.message : "Something went wrong.",
      }));
    }
  }

  const spent = turns
    .flatMap((t) => t.items)
    .reduce((sum, i) => (i.kind === "step" && i.step.type === "payment_settled" ? sum + (i.step.amount ?? 0) : sum), 0);

  const suggestion = agent?.apiUrl
    ? `Access the premium endpoint at ${agent.apiUrl.replace(/\/$/, "")}/content`
    : null;

  return (
    <section className="mt-14">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-semibold tracking-[-0.019em] text-[#040217]">Chat with your agent</h2>
        <div className="flex items-center gap-3">
          {spent > 0 && (
            <span className="rounded-full bg-[#f1f2f9] px-3 py-1 text-xs text-[#040217]">
              Spent in this chat: {formatAmount(spent)}
            </span>
          )}
          <button
            type="button"
            disabled={busy || turns.length === 0}
            onClick={() => {
              setTurns([]);
              setSessionId(newSessionId());
            }}
            className="inline-flex items-center gap-1 text-sm text-[#64668b] hover:text-[#040217] disabled:opacity-40"
          >
            <RotateCcw className="size-4" /> New chat
          </button>
        </div>
      </div>
      <p className="mt-1 text-sm text-[#64668b]">
        {agent?.configured
          ? `Talking to ${agent.runtimeName} on Amazon Bedrock AgentCore Runtime.`
          : agent
            ? "No deployed agent found yet. Run agentcore deploy in your IDE, then reload this page."
            : "Looking for your deployed agent..."}
      </p>

      <div className="mt-3 flex flex-col gap-4 rounded-2xl border border-[#e2e3f0] bg-white px-6 py-5">
        {turns.length === 0 && (
          <div className="flex flex-col items-start gap-2 text-sm text-[#64668b]">
            <span>Ask the agent to fetch your paid API. It pays the 402 itself, within your session budget.</span>
            {suggestion && (
              <button
                type="button"
                onClick={() => setPrompt(suggestion)}
                className="rounded-full border border-[#e2e3f0] px-3 py-1 text-left text-xs text-[#040217] hover:bg-[#f1f2f9]"
              >
                {suggestion}
              </button>
            )}
          </div>
        )}

        {turns.map((turn) => (
          <div key={turn.id} className="flex flex-col gap-3">
            <div className="self-end rounded-2xl bg-[#111826] px-4 py-2 text-sm text-white">{turn.prompt}</div>
            <div className="flex flex-col gap-2">
              {turn.items.map((item, i) =>
                item.kind === "text" ? (
                  <TextBlock key={i} text={item.text} />
                ) : (
                  <StepRow key={i} step={item.step} />
                ),
              )}
              {turn.status === "running" && (
                <div className="flex items-center gap-2 text-sm text-[#64668b]">
                  <LoaderCircle className="size-4 animate-spin" />
                  {turn.items.length === 0 ? "Starting the agent session..." : "Working..."}
                </div>
              )}
              {turn.status === "error" && (
                <div className="flex items-center gap-2 text-sm text-[#991b1b]">
                  <CircleAlert className="size-4" /> {turn.error}
                </div>
              )}
            </div>
          </div>
        ))}
        <div ref={bottomRef} />

        <form onSubmit={send} className="flex items-center gap-2 border-t border-[#e2e3f0] pt-4">
          <input
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={!agent?.configured || busy}
            placeholder="Ask your agent..."
            maxLength={2000}
            className="h-11 flex-1 rounded-full border border-[#e2e3f0] px-4 text-sm outline-none focus:border-[#111826] disabled:bg-[#FAFAFA]"
          />
          <button
            type="submit"
            disabled={!agent?.configured || busy || !prompt.trim()}
            className="inline-flex size-11 items-center justify-center rounded-full bg-[#111826] text-white disabled:opacity-40"
            aria-label="Send"
          >
            <Send className="size-4" />
          </button>
        </form>
      </div>
    </section>
  );
}
