// SPDX-License-Identifier: Apache-2.0
import * as SliderPrimitive from '@radix-ui/react-slider';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * A single-value slider (Radix: role="slider", arrows, Shift+arrows, Page
 * keys, Home/End). The thumb grows a little while held, so the hand knows it
 * has it; values move with the pointer, never eased — a slider that lags
 * behind the finger feels broken.
 */
export const Slider = forwardRef<
	ElementRef<typeof SliderPrimitive.Root>,
	ComponentPropsWithoutRef<typeof SliderPrimitive.Root> & { thumbLabel?: string }
>(function Slider({ className, thumbLabel, ...props }, ref) {
	return (
		<SliderPrimitive.Root
			ref={ref}
			className={cn(
				'relative flex h-5 w-full touch-none select-none items-center data-[disabled]:opacity-50',
				className,
			)}
			{...props}
		>
			<SliderPrimitive.Track className="relative h-1 w-full grow overflow-hidden rounded-full bg-line-strong">
				<SliderPrimitive.Range className="absolute h-full rounded-full bg-accent" />
			</SliderPrimitive.Track>
			<SliderPrimitive.Thumb
				aria-label={thumbLabel}
				className={cn(
					'block size-3.5 rounded-full bg-fg shadow-[0_1px_3px_rgb(0_0_0/0.35),0_0_0_1px_rgb(0_0_0/0.15)]',
					'transition-transform duration-150 ease-out active:scale-[1.18] motion-reduce:transition-none',
					'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
					'data-[disabled]:pointer-events-none',
				)}
			/>
		</SliderPrimitive.Root>
	);
});
