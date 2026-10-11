'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { getSupabase, supabaseConfigError } from './lib/supabase';

export default function Home() {
  const [message, setMessage] = useState('Connecting to database...');

  useEffect(() => {
    async function testConnection() {
      const supabase = getSupabase();
      if (!supabase) return setMessage(supabaseConfigError);
      const { error } = await supabase.from('profiles').select('id').limit(1);
      if (error) {
        setMessage('Database connection error: ' + error.message);
      } else {
        setMessage('Connected to Supabase successfully!');
      }
    }
    testConnection();
  }, []);

  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui' }}>
      <h1>TMS App</h1>
      <p>{message}</p>
      <p><Link href="/dashboard" style={{ color: '#2563eb' }}>Weekly dashboard →</Link></p>
      <p><Link href="/documents" style={{ color: '#2563eb' }}>Upload rate confirmations →</Link></p>
      <p><Link href="/loads" style={{ color: '#2563eb' }}>Loads →</Link></p>
      <p><Link href="/mileage" style={{ color: '#2563eb' }}>Mileage →</Link></p>
      <p><Link href="/expenses" style={{ color: '#2563eb' }}>Expenses →</Link></p>
      <p><Link href="/login" style={{ color: '#2563eb' }}>Sign in →</Link></p>
    </main>
  );
}
