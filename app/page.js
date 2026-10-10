'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from './lib/supabase';

export default function Home() {
  const [message, setMessage] = useState('Connecting to database...');

  useEffect(() => {
    async function testConnection() {
      const { data, error } = await supabase.from('profiles').select('id').limit(1);
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
      <p><Link href="/documents" style={{ color: '#2563eb' }}>Upload rate confirmations →</Link></p>
      <p><Link href="/login" style={{ color: '#2563eb' }}>Sign in →</Link></p>
    </main>
  );
}
