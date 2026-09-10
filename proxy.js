import { NextResponse } from "next/server";
import { sha256Hex, AUTH_COOKIE } from "./lib/auth";

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};

const PUBLIC_PATHS = ["/login", "/api/login"];

export async function proxy(req) {
  const { pathname } = req.nextUrl;
  if (PUBLIC_PATHS.includes(pathname)) return NextResponse.next();

  const password = process.env.DASHBOARD_PASSWORD;
  // No password configured yet (fresh local setup) - don't lock the owner out.
  if (!password) return NextResponse.next();

  const expected = await sha256Hex(password);
  const cookie = req.cookies.get(AUTH_COOKIE)?.value;

  if (cookie === expected) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Not authenticated." }, { status: 401 });
  }

  const loginUrl = new URL("/login", req.url);
  loginUrl.searchParams.set("next", pathname);
  return NextResponse.redirect(loginUrl);
}
