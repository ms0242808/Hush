// SPDX-License-Identifier: Apache-2.0
import { Lock, X } from 'lucide-react';
import { useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

export const SOURCE_URL = 'https://github.com/ms0242808/Hush';

/**
 * Always visible (§5.2): the privacy promise, and a way to check it. Every
 * sentence in the dialog is verifiable by the reader.
 */
export function PrivacyNote() {
	const { t } = useTranslation();
	const dialog = useRef<HTMLDialogElement>(null);

	return (
		<>
			<p className="flex flex-wrap items-center justify-center gap-x-2 gap-y-1 text-center text-[13px] text-fg-muted">
				<Lock aria-hidden="true" className="size-3.5 shrink-0 text-fg-subtle" />
				<span>{t('privacy.line')}</span>
				<Button variant="link" size="sm" className="text-[13px]" onClick={() => dialog.current?.showModal()}>
					{t('privacy.how')}
				</Button>
			</p>

			<dialog
				ref={dialog}
				aria-labelledby="privacy-title"
				onClick={(event) => {
					if (event.target === event.currentTarget) event.currentTarget.close(); // backdrop click
				}}
				className="m-auto w-[min(92vw,30rem)] rounded-2xl border border-line-strong bg-surface p-0 text-fg shadow-2xl shadow-black/40 [transition:opacity_200ms_var(--ease-out),transform_200ms_var(--ease-out)] starting:scale-[0.96] starting:opacity-0 motion-reduce:starting:scale-100"
			>
				<div className="flex flex-col gap-4 p-6">
					<div className="flex items-start justify-between gap-4">
						<h2 id="privacy-title" className="text-[16px] font-semibold tracking-[-0.01em]">
							{t('privacy.title')}
						</h2>
						<Button
							variant="ghost"
							size="icon"
							aria-label={t('privacy.close')}
							className="-mr-2 -mt-1"
							onClick={() => dialog.current?.close()}
						>
							<X />
						</Button>
					</div>
					<ol className="flex list-decimal flex-col gap-3 pl-5 text-[14px] leading-relaxed text-fg-muted marker:text-fg-subtle">
						<li>{t('privacy.local')}</li>
						<li>{t('privacy.enforced')}</li>
						<li>{t('privacy.open')}</li>
					</ol>
					<a
						href={SOURCE_URL}
						target="_blank"
						rel="noreferrer"
						className="self-start text-[14px] font-medium text-accent underline-offset-4 hover:underline"
					>
						{t('privacy.source')}
					</a>
				</div>
			</dialog>
		</>
	);
}
