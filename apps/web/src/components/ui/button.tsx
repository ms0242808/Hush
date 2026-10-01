// SPDX-License-Identifier: Apache-2.0
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';
import { forwardRef, type ButtonHTMLAttributes } from 'react';
import { cn } from '@/lib/utils';

/*
 * Pressable feedback: a quick scale on :active so the interface feels like it
 * heard the press. Transitions name their properties; never `all`.
 */
const buttonVariants = cva(
	[
		'inline-flex select-none items-center justify-center gap-2 whitespace-nowrap rounded-lg font-medium',
		'transition-[transform,background-color,border-color,color,opacity] duration-150 ease-out',
		'active:scale-[0.97] motion-reduce:active:scale-100',
		'disabled:pointer-events-none disabled:opacity-50',
		'[&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0',
	],
	{
		variants: {
			variant: {
				primary: 'bg-accent text-accent-fg hover:bg-accent-hover',
				secondary: 'border border-line-strong bg-raised text-fg hover:border-fg-subtle/60',
				ghost: 'text-fg-muted hover:bg-raised hover:text-fg',
				link: 'h-auto px-0 text-accent underline-offset-4 hover:underline active:scale-100',
			},
			size: {
				sm: 'h-8 px-3 text-[13px]',
				md: 'h-9 px-4 text-[14px]',
				lg: 'h-11 px-5 text-[15px]',
				icon: 'size-8',
			},
		},
		defaultVariants: { variant: 'secondary', size: 'md' },
	},
);

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement>, VariantProps<typeof buttonVariants> {
	asChild?: boolean;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
	{ className, variant, size, asChild = false, type, ...props },
	ref,
) {
	const Component = asChild ? Slot : 'button';
	return (
		<Component
			ref={ref}
			className={cn(buttonVariants({ variant, size }), className)}
			{...(asChild ? {} : { type: type ?? 'button' })}
			{...props}
		/>
	);
});
