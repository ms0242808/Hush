// SPDX-License-Identifier: Apache-2.0
import type { ReactNode } from 'react';
import { cn } from '@/lib/utils';

export function Kbd({ children, className }: { children: ReactNode; className?: string }) {
	return (
		<kbd
			className={cn(
				'inline-flex h-5 min-w-5 items-center justify-center rounded-md border border-line-strong bg-sunken px-1.5 font-sans text-[11px] font-medium text-fg-muted',
				className,
			)}
		>
			{children}
		</kbd>
	);
}
