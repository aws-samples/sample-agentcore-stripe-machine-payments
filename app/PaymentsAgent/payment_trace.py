"""Report what the agent did during a turn, so a chat UI can show it.

The payments plugin settles HTTP 402 challenges inside the tool call, so the
model never sees them. This hook watches the same tool calls and records each
step (request, 402 challenge, paid retry, receipt) as a small dictionary.
main.py streams these to the caller as {"trace": {...}} events, next to the
model's own text.

Nothing secret is reported: the signed payment header is reduced to a flag.
"""

import base64
import json
import re
from collections import deque
from typing import Any, Optional

from strands.hooks import AfterToolCallEvent, BeforeToolCallEvent, HookProvider, HookRegistry

_PAYMENT_REQUIRED_PREFIX = "PAYMENT_REQUIRED: "
_USDC_DECIMALS = 6


def _b64_json(value: Any) -> Optional[dict]:
    """Decode a base64 or base64url encoded JSON header value."""
    if not isinstance(value, str) or not value:
        return None
    try:
        padded = value + "=" * (-len(value) % 4)
        decoded = base64.urlsafe_b64decode(padded.replace("+", "-").replace("/", "_"))
        data = json.loads(decoded)
    except (ValueError, json.JSONDecodeError):
        return None
    return data if isinstance(data, dict) else None


def _http_response(result: Any) -> Optional[dict]:
    """Return the {statusCode, headers, body} dict that http_request produced."""
    if not isinstance(result, dict):
        return None
    for block in result.get("content", []):
        text = block.get("text") if isinstance(block, dict) else None
        if not isinstance(text, str):
            continue
        if text.startswith(_PAYMENT_REQUIRED_PREFIX):
            text = text[len(_PAYMENT_REQUIRED_PREFIX):]
        try:
            data = json.loads(text)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and "statusCode" in data:
            return data
    return None


def _challenge(headers: dict) -> dict:
    """Summarize what a 402 asks for: amount, currency, recipient, network."""
    # x402 v2: base64 JSON in the Payment-Required header.
    required = _b64_json(headers.get("payment-required"))
    if required and isinstance(required.get("accepts"), list) and required["accepts"]:
        offer = required["accepts"][0]
        return {
            "protocol": "x402",
            "amount": int(offer.get("amount", 0)) / 10**_USDC_DECIMALS,
            "currency": (offer.get("extra") or {}).get("name", "USDC"),
            "recipient": offer.get("payTo"),
            "network": offer.get("network"),
        }
    # MPP: base64 JSON in the request="..." parameter of WWW-Authenticate.
    match = re.search(r'request="([^"]+)"', headers.get("www-authenticate", ""))
    request = _b64_json(match.group(1)) if match else None
    if request:
        decimals = (request.get("methodDetails") or {}).get("decimals", _USDC_DECIMALS)
        chain_id = (request.get("methodDetails") or {}).get("chainId")
        return {
            "protocol": "mpp",
            "amount": int(request.get("amount", 0)) / 10**decimals,
            "currency": "USDC",
            "recipient": request.get("recipient"),
            "network": f"eip155:{chain_id}" if chain_id else None,
        }
    return {}


class PaymentTrace(HookProvider):
    """Collects one event per notable step; main.py drains them while streaming."""

    def __init__(self) -> None:
        self._events: deque = deque()
        self._challenges: dict = {}
        # 402s not yet followed by a receipt: tool_use_id -> invocation_state.
        self._unpaid: dict = {}

    def register_hooks(self, registry: HookRegistry, **kwargs: Any) -> None:
        registry.add_callback(BeforeToolCallEvent, self._before_tool_call)
        registry.add_callback(AfterToolCallEvent, self._after_tool_call)

    def reset(self) -> None:
        self._events.clear()
        self._challenges.clear()
        self._unpaid.clear()

    def _check_failures(self, final: bool) -> None:
        """Report 402s the payments plugin could not pay.

        When ProcessPayment fails (session expired, budget spent, delegation
        missing) the plugin stores the error in invocation_state under
        payment_failure_<toolUseId> and lets the 402 through to the model.
        """
        for tool_use_id, state in list(self._unpaid.items()):
            failure = state.get(f"payment_failure_{tool_use_id}") if isinstance(state, dict) else None
            if failure or final:
                failure = failure or {}
                self._events.append({
                    "type": "payment_failed",
                    "error": failure.get("exceptionType"),
                    "detail": str(failure.get("exceptionMessage") or "The payment was not completed.")[:300],
                })
                del self._unpaid[tool_use_id]

    def finish(self) -> list:
        """Call once the turn is over; flags any 402 that was never paid."""
        self._check_failures(final=True)
        return self.drain()

    def drain(self) -> list:
        self._check_failures(final=False)
        items = []
        while self._events:
            items.append(self._events.popleft())
        return items

    def _before_tool_call(self, event: BeforeToolCallEvent) -> None:
        tool = event.tool_use.get("name", "unknown")
        tool_input = event.tool_use.get("input") or {}
        step = {"type": "tool_call", "tool": tool}
        if tool == "http_request" and isinstance(tool_input, dict):
            headers = tool_input.get("headers") or {}
            auth = headers.get("Authorization", "") if isinstance(headers, dict) else ""
            step.update(
                method=str(tool_input.get("method", "GET")).upper(),
                url=tool_input.get("url"),
                withPayment=isinstance(auth, str) and auth.startswith("Payment ")
                or (isinstance(headers, dict) and any(k.upper() in ("X-PAYMENT", "PAYMENT-SIGNATURE") for k in headers)),
            )
        self._events.append(step)

    def _after_tool_call(self, event: AfterToolCallEvent) -> None:
        tool = event.tool_use.get("name", "unknown")
        tool_use_id = event.tool_use.get("toolUseId")
        response = _http_response(event.result) if tool == "http_request" else None
        if response is None:
            status = event.result.get("status") if isinstance(event.result, dict) else None
            self._events.append({"type": "tool_result", "tool": tool, "status": status})
            return

        status_code = response.get("statusCode")
        headers = {str(k).lower(): v for k, v in (response.get("headers") or {}).items()}

        if status_code == 402:
            body = response.get("body") if isinstance(response.get("body"), dict) else {}
            if tool_use_id in self._challenges:
                self._unpaid.pop(tool_use_id, None)
                # Already paid once for this call and the seller still refused.
                detail = str(body.get("detail") or body.get("title") or "The seller rejected the payment.")
                reason = re.search(r"Details: (.+)", detail)
                self._events.append({
                    "type": "payment_rejected",
                    # Facilitator errors embed the raw transaction; keep the readable part.
                    "detail": (detail.splitlines()[0] + (f" ({reason.group(1).strip()})" if reason else ""))[:300],
                })
            else:
                challenge = _challenge(headers)
                self._challenges[tool_use_id] = challenge
                self._unpaid[tool_use_id] = event.invocation_state
                self._events.append({"type": "payment_required", **challenge})
            return

        receipt = _b64_json(headers.get("payment-receipt") or headers.get("payment-response"))
        if receipt:
            self._unpaid.pop(tool_use_id, None)
            challenge = self._challenges.get(tool_use_id, {})
            self._events.append({
                "type": "payment_settled",
                "txHash": receipt.get("reference") or receipt.get("transaction"),
                "amount": challenge.get("amount"),
                "currency": challenge.get("currency", "USDC"),
                "network": challenge.get("network") or receipt.get("network"),
            })
        self._events.append({"type": "tool_result", "tool": tool, "statusCode": status_code})
