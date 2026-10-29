'use client';

import { useFormStatus } from 'react-dom';
import { buttonPrimary } from '@/components/ui';

export function SubmitButton({ children, pendingText = 'Please wait…', className }: { children: React.ReactNode; pendingText?: string; className?: string }) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" disabled={pending} className={className ?? `${buttonPrimary} w-full`}>
      {pending ? pendingText : children}
    </button>
  );
}
