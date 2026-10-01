// SPDX-License-Identifier: Apache-2.0
import type { GpuAssessment } from '@hush/core';
import { Cpu, X } from 'lucide-react';
import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';

const MESSAGE = {
	'use-another-browser': 'notice.useAnotherBrowser',
	'update-browser': 'notice.updateBrowser',
	'turn-on-acceleration': 'notice.turnOnAcceleration',
	'processor-only': 'notice.processorOnly',
} as const;

/**
 * Shown only when the GPU can't be used (§5.12): the situation, the
 * consequence, the fix — in that order. Dismissible; never blocks the drop zone.
 */
export function CapabilityNotice({ assessment }: { assessment: GpuAssessment }) {
	const { t } = useTranslation();
	const [dismissed, setDismissed] = useState(false);
	const [showSteps, setShowSteps] = useState(false);
	const stepsId = useId();

	if (assessment.notice === 'none' || dismissed) return null;
	// Steps help when acceleration is off, and when we can't tell (no WebGL at all) — not on a VM.
	const canShowSteps =
		assessment.notice === 'turn-on-acceleration' ||
		(assessment.notice === 'processor-only' && assessment.rendererHint === 'none');

	return (
		<div
			role="status"
			data-testid="capability-notice"
			data-notice={assessment.notice}
			data-situation={assessment.situation}
			className="enter-up flex w-full max-w-2xl gap-3 rounded-xl border border-line-strong bg-surface px-4 py-3 text-left"
		>
			<Cpu aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-warning" />
			<div className="flex min-w-0 flex-1 flex-col gap-2">
				<p className="text-[13px] leading-relaxed text-fg">{t(MESSAGE[assessment.notice])}</p>
				{canShowSteps && (
					<>
						<Button
							variant="link"
							size="sm"
							className="self-start text-[13px]"
							aria-expanded={showSteps}
							aria-controls={stepsId}
							onClick={() => setShowSteps((open) => !open)}
						>
							{showSteps ? t('notice.hideSteps') : t('notice.showMeHow')}
						</Button>
						{showSteps && (
							<ul id={stepsId} className="flex flex-col gap-1.5 text-[13px] leading-relaxed text-fg-muted">
								<li>{t('notice.steps.chromium')}</li>
								<li>{t('notice.steps.firefox')}</li>
								<li>{t('notice.steps.drivers')}</li>
							</ul>
						)}
					</>
				)}
			</div>
			<Button
				variant="ghost"
				size="icon"
				aria-label={t('notice.dismiss')}
				className="-mr-1.5 -mt-1 size-7"
				onClick={() => setDismissed(true)}
			>
				<X />
			</Button>
		</div>
	);
}
