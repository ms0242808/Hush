// SPDX-License-Identifier: Apache-2.0
import { X } from 'lucide-react';
import { useEffect, useId, useRef, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { Button } from './button';

/**
 * A modal on the native <dialog>: the browser traps focus, closes on
 * Escape, returns focus to the button that opened it, and puts it in the top
 * layer. It enters centred (modals aren't anchored to a trigger) with a small
 * scale and fade, and leaves at once.
 */
export function Modal({
	open,
	onClose,
	title,
	children,
	className,
	testId,
}: {
	open: boolean;
	onClose: () => void;
	title: string;
	children: ReactNode;
	className?: string;
	testId?: string;
}) {
	const { t } = useTranslation();
	const dialog = useRef<HTMLDialogElement>(null);
	const titleId = useId();

	useEffect(() => {
		const element = dialog.current;
		if (!element) return;
		if (open && !element.open) element.showModal();
		if (!open && element.open) element.close();
	}, [open]);

	return (
		<dialog
			ref={dialog}
			aria-labelledby={titleId}
			data-testid={testId}
			onClose={onClose}
			onClick={(event) => {
				if (event.target === event.currentTarget) event.currentTarget.close(); // backdrop click
			}}
			className={cn(
				'm-auto max-h-[min(88dvh,44rem)] w-[min(92vw,30rem)] overflow-y-auto overscroll-contain rounded-2xl border border-line-strong bg-surface p-0 text-fg shadow-2xl shadow-black/40',
				'[transition:opacity_200ms_var(--ease-out),transform_200ms_var(--ease-out)] starting:scale-[0.96] starting:opacity-0 motion-reduce:starting:scale-100',
				className,
			)}
		>
			{open && (
				<div className="flex flex-col gap-4 p-6">
					<div className="flex items-start justify-between gap-4">
						<h2 id={titleId} className="text-[16px] font-semibold tracking-[-0.01em]">
							{title}
						</h2>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('common.close')}
							className="-mr-2 -mt-1"
							onClick={() => dialog.current?.close()}
						>
							<X />
						</Button>
					</div>
					{children}
				</div>
			)}
		</dialog>
	);
}
