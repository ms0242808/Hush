// SPDX-License-Identifier: Apache-2.0
import { cn } from '@/lib/utils';

interface ProgressProps {
	/** 0–1, or null for an unknown amount. */
	value: number | null;
	label: string;
	className?: string;
}

/**
 * A thin bar. Progress is constant motion, so it eases linearly between
 * updates; an unknown amount shows a slow sweep instead of a spinner.
 */
export function Progress({ value, label, className }: ProgressProps) {
	const percent = value === null ? undefined : Math.round(Math.min(1, Math.max(0, value)) * 100);
	return (
		<div
			role="progressbar"
			aria-label={label}
			aria-valuemin={0}
			aria-valuemax={100}
			aria-valuenow={percent}
			className={cn('relative h-1 w-full overflow-hidden rounded-full bg-line-strong', className)}
		>
			{value === null ? (
				<div className="absolute inset-y-0 w-1/3 animate-[sweep_1.4s_ease-in-out_infinite] rounded-full bg-accent motion-reduce:animate-none motion-reduce:w-full motion-reduce:opacity-40" />
			) : (
				<div
					className="h-full origin-left rounded-full bg-accent transition-transform duration-300 ease-linear motion-reduce:transition-none"
					style={{ transform: `scaleX(${(percent ?? 0) / 100})` }}
				/>
			)}
		</div>
	);
}
