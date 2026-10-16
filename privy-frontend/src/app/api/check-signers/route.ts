import { NextRequest, NextResponse } from "next/server";

const WALLET_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_WALLETS = 10;

export async function POST(req: NextRequest) {
  const appId = process.env.NEXT_PUBLIC_PRIVY_APP_ID;
  const appSecret = process.env.PRIVY_APP_SECRET;
  const signerId = process.env.NEXT_PUBLIC_PRIVY_SIGNER_ID;

  if (!appId || !appSecret || !signerId) {
    return NextResponse.json(
      { error: "Missing server configuration" },
      { status: 500 },
    );
  }

  const { walletIds } = (await req.json()) as { walletIds: unknown };

  if (!Array.isArray(walletIds) || walletIds.length === 0) {
    return NextResponse.json({ connected: false });
  }

  // Wallet IDs come from the client and end up in a server-side request
  // that carries the app secret, so only accept plain Privy wallet IDs.
  if (
    walletIds.length > MAX_WALLETS ||
    !walletIds.every(
      (id): id is string => typeof id === "string" && WALLET_ID_PATTERN.test(id),
    )
  ) {
    return NextResponse.json({ error: "Invalid walletIds" }, { status: 400 });
  }

  const credentials = Buffer.from(`${appId}:${appSecret}`).toString("base64");

  const results = await Promise.all(
    walletIds.map(async (walletId: string) => {
      const url = `https://auth.privy.io/api/v1/wallets/${encodeURIComponent(walletId)}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Basic ${credentials}`,
          "privy-app-id": appId,
        },
      });
      if (!res.ok) return false;
      const wallet = (await res.json()) as {
        additional_signers?: { signer_id: string }[];
      };
      return (wallet.additional_signers ?? []).some(
        (s) => s.signer_id === signerId,
      );
    }),
  );

  return NextResponse.json({ connected: results.every(Boolean) });
}
