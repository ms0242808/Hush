// SPDX-License-Identifier: Apache-2.0
import { ImagePlus } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

interface DropZoneProps {
	over: boolean;
	onChoose: () => void;
}

export function DropZone({ over, onChoose }: DropZoneProps) {
	const { t } = useTranslation();
	return (
		<section
			aria-labelledby="drop-title"
			data-testid="drop-zone"
			data-over={over}
			className={cn(
				'flex flex-1 flex-col items-center justify-center gap-6 rounded-2xl border border-dashed px-6 py-10 text-center',
				'transition-[border-color,background-color] duration-150 ease-out',
				over ? 'border-accent bg-raised/60' : 'border-line-strong bg-transparent',
			)}
		>
			<div
				className={cn(
					'flex size-14 items-center justify-center rounded-2xl bg-raised text-fg-muted',
					'transition-transform duration-200 ease-out motion-reduce:transition-none',
					over && 'scale-105 text-accent',
				)}
			>
				<ImagePlus aria-hidden="true" className="size-6" strokeWidth={1.75} />
			</div>
			<div className="flex flex-col items-center gap-2">
				<h1 id="drop-title" className="text-balance text-[22px] font-semibold tracking-[-0.015em] text-fg">
					{over ? t('drop.titleActive') : t('drop.title')}
				</h1>
				<p className="text-[13px] text-fg-subtle">{t('drop.hint')}</p>
			</div>
			<Button variant="primary" size="lg" onClick={onChoose}>
				{t('drop.choose')}
			</Button>
		</section>
	);
}
