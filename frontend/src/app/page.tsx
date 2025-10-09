'use client'

import NLPInput from '@/components/NLPInput'
import RangeInput from '@/components/RangeInput'
import React, { useState, useEffect } from 'react';
import Link from 'next/link';

export default function Home() {
  const [messageRes, setMessageRes] = useState<string | null>(null);
  const handleMessageReturn = (data: string) => {
    setMessageRes(data);
  }
  useEffect(() => {
    console.log("Updated messageRes: ", messageRes);
  }, [messageRes]);
  return (
    <main className="min-h-screen w-full">
      <div className="absolute top-4 right-4 z-10">
        <Link 
          href="/solver" 
          className="bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg shadow-lg transition-colors"
        >
          → Simple Solver UI
        </Link>
      </div>
      <div style={{ transform: 'scale(0.66)', transformOrigin: 'top center' }}>
        <RangeInput />
        <NLPInput onMessageReturn={(data: string) => {handleMessageReturn(data)}}/>
        <div> 
          {messageRes ? <h1>{messageRes}</h1> : null}
        </div>
      </div>
    </main>
  )
}