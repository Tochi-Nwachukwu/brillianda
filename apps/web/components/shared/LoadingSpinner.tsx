'use client';

export function LoadingSpinner({ className }: { className?: string }) {
  return (
    <div className={className}>
      <div className="w-8 h-8 border-4 border-[#FF6B00] border-t-transparent rounded-full animate-spin" />
    </div>
  );
}
