'use client';

import { cn } from '@/lib/utils';

interface CountdownTimerProps {
  formattedTime: string;
  isWarning: boolean;
  isExpired: boolean;
}

export function CountdownTimer({ formattedTime, isWarning, isExpired }: CountdownTimerProps) {
  return (
    <div
      className={cn(
        'fixed top-0 left-0 right-0 z-50 h-12 flex items-center justify-center text-lg font-bold tracking-wider transition-colors',
        isExpired
          ? 'bg-red-600 text-white'
          : isWarning
          ? 'bg-amber-500 text-white animate-pulse'
          : 'bg-[#0A1F44] text-white'
      )}
    >
      {isExpired ? "Time's Up!" : formattedTime}
    </div>
  );
}
