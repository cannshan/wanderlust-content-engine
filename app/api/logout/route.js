import { NextResponse } from "next/server";
import { AUTH_COOKIE } from "../../../lib/auth";

// Clears the same cookie /api/login sets - maxAge: 0 deletes it
// immediately rather than just expiring it in the future. No password
// check needed here (unlike login): if the request got this far at all,
// proxy.js already confirmed it carried a valid cookie.
export async function POST() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(AUTH_COOKIE, "", {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 0,
    path: "/",
  });
  return res;
}
