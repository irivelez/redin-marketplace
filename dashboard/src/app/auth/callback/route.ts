import { NextResponse } from "next/server";
import { serverClientBoundToCookies } from "@/lib/supabase-server";

// IMPORTANT: do not derive the redirect base from request.url. Behind
// Railway's proxy, Next.js reports the container's internal host
// (https://localhost:8080) instead of the public domain. We pin to
// NEXT_PUBLIC_SITE_URL so redirects always land on the public host.
const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL ||
  "https://dashboard-mp-production-1ef3.up.railway.app";

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");
  const next = searchParams.get("next") ?? "/hr/pipeline";

  const supabase = serverClientBoundToCookies();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(`${SITE_URL}${next}`);
  }

  if (tokenHash && type) {
    const { error } = await supabase.auth.verifyOtp({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      type: type as any,
      token_hash: tokenHash,
    });
    if (!error) return NextResponse.redirect(`${SITE_URL}${next}`);
  }

  return NextResponse.redirect(
    `${SITE_URL}/login?error=${encodeURIComponent("invalid_or_expired_link")}`
  );
}
