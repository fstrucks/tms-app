'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { loginHref } from '../lib/safeNext';

// "Sign in" link that brings the user back to this page afterwards (/login?next=…).
export default function SignInLink({ children = 'sign in', ...props }) {
  const [href, setHref] = useState('/login');
  useEffect(() => { setHref(loginHref(window.location.pathname + window.location.search)); }, []);
  return <Link href={href} {...props}>{children}</Link>;
}
