// SPDX-License-Identifier: Apache-2.0
import * as SwitchPrimitive from '@radix-ui/react-switch';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils';

/** An on/off setting (role="switch"). The knob slides on the same curve as everything else that moves. */
export const Switch = forwardRef<
	ElementRef<typeof SwitchPrimitive.Root>,
	ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
	return (
		<SwitchPrimitive.Root
			ref={ref}
			className={cn(
				'peer inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full p-0.5',
				'bg-line-strong transition-[background-color] duration-200 ease-out data-[state=checked]:bg-accent',
				'disabled:cursor-not-allowed disabled:opacity-50',
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				className={cn(
					'pointer-events-none block size-4 rounded-full bg-fg shadow-sm shadow-black/30',
					'transition-transform duration-200 [transition-timing-function:var(--ease-out)] data-[state=checked]:translate-x-4',
					'motion-reduce:transition-none data-[state=checked]:bg-accent-fg',
				)}
			/>
		</SwitchPrimitive.Root>
	);
});
