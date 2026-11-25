import { NextResponse } from 'next/server';
import { siteRewritePath } from './app/lib/siteHost';

// Only "/" runs through here: pwrstrong.net / www.pwrstrong.net get the public site page.
export function middleware(req) {
  const to = siteRewritePath(req.headers.get('host'), req.nextUrl.pathname);
  if (!to) return NextResponse.next();
  const url = req.nextUrl.clone();
  url.pathname = to;
  return NextResponse.rewrite(url);
}

export const config = { matcher: '/' };
