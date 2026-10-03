// SPDX-License-Identifier: Apache-2.0
import { DENOISE_CONTROLS } from '@hush/ops';
import { useId } from 'react';
import { useTranslation } from 'react-i18next';
import { Slider } from '@/components/ui/slider';
import type { DenoiseParams } from '@/lib/presets';
import { setParam, useEditor } from '../store';

const CONTROLS: { id: keyof DenoiseParams; label: string }[] = [
	{ id: 'strength', label: 'controls.strength' },
	{ id: 'luma', label: 'controls.luma' },
	{ id: 'colour', label: 'controls.colour' },
	{ id: 'detail', label: 'controls.detail' },
];

const defaultOf = (id: keyof DenoiseParams) => DENOISE_CONTROLS.find((control) => control.id === id)!.default;

/**
 * Strength, Luminance noise, Colour noise, Detail (§2.5). Each is a blend
 * the viewer recomputes on the GPU, so they follow the pointer exactly.
 * Double-click a label to put that slider back, as in Lightroom.
 */
export function Sliders({ disabled }: { disabled: boolean }) {
	const { t } = useTranslation();
	const params = useEditor((state) => state.params);
	const id = useId();
	return (
		<div className="flex flex-col gap-4" data-testid="sliders">
			{CONTROLS.map((control) => {
				const value = Math.round(params[control.id] * 100);
				return (
					<div key={control.id} className="flex flex-col gap-2">
						<div className="flex items-baseline justify-between gap-3">
							<label
								id={`${id}-${control.id}`}
								className="cursor-default select-none text-[13px] text-fg-muted"
								title={t('controls.resetHint')}
								onDoubleClick={() => !disabled && setParam(control.id, defaultOf(control.id))}
							>
								{t(control.label)}
							</label>
							<output aria-hidden="true" className="tabular min-w-[2.5ch] text-right text-[13px] font-medium text-fg">
								{value}
							</output>
						</div>
						<Slider
							value={[value]}
							min={0}
							max={100}
							step={1}
							disabled={disabled}
							thumbLabel={t(control.label)}
							aria-labelledby={`${id}-${control.id}`}
							onValueChange={([next]) => next !== undefined && setParam(control.id, next / 100)}
						/>
					</div>
				);
			})}
		</div>
	);
}
