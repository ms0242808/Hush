// SPDX-License-Identifier: Apache-2.0
import { History } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { BatchRecord } from '@/lib/batch-record';

/**
 * A batch that stopped partway — the tab closed, the browser crashed, the
 * laptop restarted — offered back on the drop zone (§2.7): from a folder,
 * one click and one permission; from files, choose them again and what's
 * done is skipped.
 */
export function ResumeBatch({
	record,
	onResume,
	onDiscard,
}: {
	record: BatchRecord;
	onResume: () => void;
	onDiscard: () => void;
}) {
	const { t } = useTranslation();
	const total = record.items.length;
	const done = record.items.filter((item) => item.done).length;
	const fromFolder = record.source.kind === 'folder';
	return (
		<section
			aria-labelledby="resume-title"
			data-testid="resume-batch"
			className="enter-up flex w-full max-w-2xl gap-3 rounded-xl border border-line-strong bg-surface px-4 py-3 text-left"
		>
			<History aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-fg-muted" />
			<div className="flex min-w-0 flex-1 flex-col gap-2.5">
				<div className="flex flex-col gap-1">
					<h2 id="resume-title" className="text-[13px] font-medium text-fg">
						{t('resume.title')}
					</h2>
					<p className="text-[13px] leading-relaxed text-fg-muted">
						{fromFolder
							? t('resume.folder', { done, total, folder: record.source.name })
							: t('resume.files', { done, total })}
					</p>
				</div>
				<div className="flex flex-wrap justify-end gap-2">
					<Button size="sm" variant="ghost" onClick={onDiscard}>
						{t('resume.dismiss')}
					</Button>
					<Button size="sm" variant="primary" onClick={onResume}>
						{fromFolder ? t('resume.continue') : t('resume.chooseAgain')}
					</Button>
				</div>
			</div>
		</section>
	);
}
