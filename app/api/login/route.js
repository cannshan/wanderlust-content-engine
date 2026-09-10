import { NextResponse } from "next/server";
import { sha256Hex, AUTH_COOKIE } from "../../../lib/auth";

export async function POST(req) {
  const { password } = await req.json().catch(() => ({}));
  const expected = process.env.DASHBOARD_PASSWORD;

  if (!expected) {
    return NextResponse.json(
      { error: "DASHBOARD_PASSWORD is not set on the server." },
      { status: 500 }
    );
  }

  if (password !== expected) {
    return NextResponse.json({ error: "Wrong password." }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, await sha256Hex(expected), {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 60 * 60 * 24 * 30,
    path: "/",
  });
  return res;
}
