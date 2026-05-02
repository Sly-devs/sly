'use client';

import { Radar } from 'lucide-react';
import { ScannerSection } from '@/components/operations/scanner-section';

export default function ScannerPage() {
  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-gray-900 dark:text-white flex items-center gap-2">
          <Radar className="h-6 w-6" />
          Scanner
        </h1>
        <p className="text-sm text-gray-500 mt-1">
          Agentic-commerce scanner — usage, credits, and audit trail
        </p>
      </div>
      <ScannerSection />
    </div>
  );
}
