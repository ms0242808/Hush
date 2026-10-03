// SPDX-License-Identifier: Apache-2.0
import * as Menu from '@radix-ui/react-dropdown-menu';
import { Check } from 'lucide-react';
import { forwardRef, type ComponentPropsWithoutRef, type ElementRef } from 'react';
import { cn } from '@/lib/utils';

/**
 * Menus grow out of the button that opened them (transform-origin from
 * Radix) in 160 ms, and close at once.
 */
export const DropdownMenu = Menu.Root;
export const DropdownMenuTrigger = Menu.Trigger;
export const DropdownMenuGroup = Menu.Group;
export const DropdownMenuRadioGroup = Menu.RadioGroup;

export const DropdownMenuContent = forwardRef<
	ElementRef<typeof Menu.Content>,
	ComponentPropsWithoutRef<typeof Menu.Content>
>(function DropdownMenuContent({ className, sideOffset = 6, ...props }, ref) {
	return (
		<Menu.Portal>
			<Menu.Content
				ref={ref}
				sideOffset={sideOffset}
				className={cn(
					'menu-surface z-50 min-w-[12rem] overflow-hidden rounded-xl border border-line-strong bg-raised p-1 text-fg shadow-xl shadow-black/30',
					className,
				)}
				{...props}
			/>
		</Menu.Portal>
	);
});

const itemClass =
	'relative flex h-8 cursor-default select-none items-center gap-2 rounded-lg px-2.5 text-[13px] outline-none data-[disabled]:pointer-events-none data-[highlighted]:bg-line-strong data-[disabled]:opacity-45 [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-fg-subtle';

export const DropdownMenuItem = forwardRef<ElementRef<typeof Menu.Item>, ComponentPropsWithoutRef<typeof Menu.Item>>(
	function DropdownMenuItem({ className, ...props }, ref) {
		return <Menu.Item ref={ref} className={cn(itemClass, className)} {...props} />;
	},
);

export const DropdownMenuRadioItem = forwardRef<
	ElementRef<typeof Menu.RadioItem>,
	ComponentPropsWithoutRef<typeof Menu.RadioItem>
>(function DropdownMenuRadioItem({ className, children, ...props }, ref) {
	return (
		<Menu.RadioItem ref={ref} className={cn(itemClass, 'pl-8', className)} {...props}>
			<span className="absolute left-2.5 flex size-4 items-center justify-center">
				<Menu.ItemIndicator>
					<Check className="text-accent!" />
				</Menu.ItemIndicator>
			</span>
			{children}
		</Menu.RadioItem>
	);
});

export function DropdownMenuSeparator({ className }: { className?: string }) {
	return <Menu.Separator className={cn('mx-1 my-1 h-px bg-line-strong', className)} />;
}

export function DropdownMenuLabel({ className, children }: { className?: string; children: React.ReactNode }) {
	return (
		<Menu.Label
			className={cn('px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-[0.06em] text-fg-subtle', className)}
		>
			{children}
		</Menu.Label>
	);
}
