'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface UseExamTimerInput {
  durationMinutes: number;
  startTime: string;
  attemptId: string;
  onExpire: () => void;
}

interface UseExamTimerOutput {
  remainingSeconds: number;
  formattedTime: string;
  isExpired: boolean;
  isWarning: boolean;
}

function formatTime(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

export function useExamTimer({
  durationMinutes,
  startTime,
  attemptId,
  onExpire,
}: UseExamTimerInput): UseExamTimerOutput {
  const storageKey = `exam_timer_${attemptId}`;
  const initialElapsed = Date.now() - new Date(startTime).getTime();
  const initialRemaining = Math.max(
    0,
    Math.floor(durationMinutes * 60 - initialElapsed / 1000)
  );

  const [remainingSeconds, setRemainingSeconds] = useState(() => {
    if (typeof window !== 'undefined') {
      const saved = localStorage.getItem(storageKey);
      if (saved) {
        const parsed = parseInt(saved, 10);
        if (!isNaN(parsed)) return Math.max(0, parsed);
      }
    }
    return initialRemaining;
  });

  const hasExpired = useRef(false);

  const tick = useCallback(() => {
    setRemainingSeconds((prev) => {
      const next = prev - 1;
      if (next <= 0) {
        localStorage.setItem(storageKey, '0');
        return 0;
      }
      localStorage.setItem(storageKey, String(next));
      return next;
    });
  }, [storageKey]);

  useEffect(() => {
    if (remainingSeconds <= 0) {
      if (!hasExpired.current) {
        hasExpired.current = true;
        onExpire();
      }
      return;
    }

    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [remainingSeconds, tick, onExpire]);

  return {
    remainingSeconds,
    formattedTime: formatTime(remainingSeconds),
    isExpired: remainingSeconds <= 0,
    isWarning: remainingSeconds > 0 && remainingSeconds < 300,
  };
}
