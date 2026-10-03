// SPDX-License-Identifier: Apache-2.0
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import type { ReactNode } from 'react';
import { Kbd } from './kbd';

/**
 * Tooltips wait before the first one appears (no flicker while the pointer
 * passes by), then open instantly — no animation — while moving between
 * neighbours, so a toolbar reads at the speed of the hand.
 */
export const TooltipProvider = ({ children }: { children: ReactNode }) => (
	<TooltipPrimitive.Provider delayDuration={450} skipDelayDuration={400}>
		{children}
	</TooltipPrimitive.Provider>
);

export function Tooltip({
	label,
	keys,
	children,
	side = 'bottom',
}: {
	label: string;
	keys?: string[] | undefined;
	children: ReactNode;
	side?: 'top' | 'bottom' | 'left' | 'right';
}) {
	return (
		<TooltipPrimitive.Root>
			<TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
			<TooltipPrimitive.Portal>
				<TooltipPrimitive.Content
					side={side}
					sideOffset={6}
					className="tooltip-surface z-50 flex items-center gap-2 rounded-lg border border-line-strong bg-raised px-2.5 py-1.5 text-[12px] text-fg shadow-lg shadow-black/30"
				>
					{label}
					{keys && (
						<span className="flex gap-0.5">
							{keys.map((key) => (
								<Kbd key={key}>{key}</Kbd>
							))}
						</span>
					)}
				</TooltipPrimitive.Content>
			</TooltipPrimitive.Portal>
		</TooltipPrimitive.Root>
	);
}
