// SPDX-License-Identifier: Apache-2.0
import { useRef, type KeyboardEvent } from 'react';
import { cn } from '@/lib/utils';

export interface SegmentedOption<T extends string | number> {
	value: T;
	label: string;
	disabled?: boolean;
}

interface SegmentedProps<T extends string | number> {
	label: string;
	value: T;
	options: SegmentedOption<T>[];
	onChange: (value: T) => void;
	disabled?: boolean;
	testId?: string;
}

/**
 * A radio group drawn as a segmented control. Arrow keys move between options
 * (roving tabindex); selection changes are instant because they're frequent.
 */
export function Segmented<T extends string | number>({
	label,
	value,
	options,
	onChange,
	disabled,
	testId,
}: SegmentedProps<T>) {
	const buttons = useRef<Array<HTMLButtonElement | null>>([]);
	const enabled = options.filter((o) => !o.disabled);

	const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
		const delta = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
		if (!delta || enabled.length === 0) return;
		event.preventDefault();
		const index = enabled.findIndex((o) => o.value === value);
		const next = enabled[(index + delta + enabled.length) % enabled.length]!;
		onChange(next.value);
		buttons.current[options.indexOf(next)]?.focus();
	};

	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[12px] font-medium text-fg-subtle">{label}</span>
			<div
				role="radiogroup"
				aria-label={label}
				data-testid={testId}
				onKeyDown={onKeyDown}
				className="flex flex-wrap gap-0.5 rounded-lg bg-sunken p-0.5"
			>
				{options.map((option, i) => {
					const checked = option.value === value;
					return (
						<button
							key={String(option.value)}
							ref={(element) => {
								buttons.current[i] = element;
							}}
							type="button"
							role="radio"
							aria-checked={checked}
							tabIndex={checked ? 0 : -1}
							disabled={disabled || option.disabled}
							onClick={() => onChange(option.value)}
							className={cn(
								'h-7 flex-1 whitespace-nowrap rounded-md px-2.5 text-[12px] font-medium transition-[background-color,color] duration-150',
								checked ? 'bg-raised text-fg shadow-sm shadow-black/20' : 'text-fg-subtle hover:text-fg-muted',
								'disabled:pointer-events-none disabled:opacity-40',
							)}
						>
							{option.label}
						</button>
					);
				})}
			</div>
		</div>
	);
}
