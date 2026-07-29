import { useState } from 'react';
import { RotateCcw } from 'lucide-react';
import { Slider } from '@/components/ui/slider';
import { cn } from '@/lib/utils';
import { Stage } from './shared';
import { asset } from '@/lib/asset';

const EN = 'The signal was always there.';

const SIZES = [
  { label: 'S', cls: 'text-[0.8rem]' },
  { label: 'M', cls: 'text-[1rem]' },
  { label: 'L', cls: 'text-[1.3rem]' },
  { label: 'XL', cls: 'text-[1.7rem]' },
];
const COLORS = [
  { id: 'white', label: 'White', swatch: 'bg-ink-1', text: 'text-ink-1' },
  { id: 'brand', label: 'Brand', swatch: 'bg-brand', text: 'text-brand' },
  { id: 'warm', label: 'Warm', swatch: 'bg-warm', text: 'text-warm' },
];

const DEFAULTS = { size: 1, color: 'white', top: false, bg: true };

/**
 * Chapter 8 demo - subtitle studio: live size / color / position / background
 * controls over a sample caption.
 */
export default function SubtitlesDemo() {
  const [sizeIdx, setSizeIdx] = useState(DEFAULTS.size);
  const [colorId, setColorId] = useState(DEFAULTS.color);
  const [top, setTop] = useState(DEFAULTS.top);
  const [bg, setBg] = useState(DEFAULTS.bg);

  const color = COLORS.find((c) => c.id === colorId) ?? COLORS[0];

  const reset = () => {
    setSizeIdx(DEFAULTS.size);
    setColorId(DEFAULTS.color);
    setTop(DEFAULTS.top);
    setBg(DEFAULTS.bg);
  };

  return (
    <Stage className="flex flex-col p-0">
      {/* mock player frame */}
      <div className="relative min-h-[250px] flex-1 overflow-hidden">
        <img src={asset('poster-03.jpg')} alt="" aria-hidden="true" className="absolute inset-0 h-full w-full object-cover opacity-30 blur-[5px]" />
        <div className="absolute inset-0" style={{ background: 'linear-gradient(180deg, rgba(var(--bg-0-rgb),0.45), rgba(var(--bg-0-rgb),0.8))' }} />

        {/* live caption */}
        <div className={cn('absolute inset-x-0 flex justify-center px-6 transition-all duration-200', top ? 'top-6' : 'bottom-6')}>
          <p
            className={cn(
              'max-w-full text-center font-body font-semibold leading-snug transition-all duration-200',
              SIZES[sizeIdx].cls,
              color.text,
              bg && 'rounded-md bg-[rgba(var(--bg-0-rgb),0.78)] px-3 py-1',
            )}
            style={bg ? undefined : { textShadow: '0 1px 8px rgba(var(--bg-0-rgb),0.9)' }}
          >
            {EN}
          </p>
        </div>
      </div>

      {/* control row */}
      <div className="flex flex-col gap-4 border-t border-line p-5">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-4">
          {/* size slider S–XL */}
          <div className="flex min-w-[170px] flex-1 items-center gap-3">
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-3">size</span>
            <Slider
              value={[sizeIdx]}
              onValueChange={(v) => setSizeIdx(v[0] ?? 1)}
              min={0}
              max={3}
              step={1}
              aria-label="Subtitle size"
              className="max-w-[130px]"
            />
            <span className="w-6 font-mono text-[0.6875rem] text-brand">{SIZES[sizeIdx].label}</span>
          </div>

          {/* color swatches */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-3">color</span>
            {COLORS.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setColorId(c.id)}
                aria-label={`Subtitle color ${c.label}`}
                aria-pressed={colorId === c.id}
                className={cn(
                  'h-5 w-5 rounded-full border transition-transform duration-150 hover:scale-110',
                  c.swatch,
                  colorId === c.id ? 'ring-2 ring-[rgba(var(--brand-rgb),0.6)] ring-offset-2 ring-offset-bg-0' : 'border-line',
                )}
              />
            ))}
          </div>

          {/* position toggle */}
          <div className="flex items-center gap-2">
            <span className="font-mono text-[0.625rem] uppercase tracking-[0.12em] text-ink-3">pos</span>
            <div className="flex rounded-chip border border-line p-0.5">
              {(['bottom', 'top'] as const).map((pos) => (
                <button
                  key={pos}
                  type="button"
                  onClick={() => setTop(pos === 'top')}
                  aria-pressed={top === (pos === 'top')}
                  className={cn(
                    'rounded-chip px-2.5 py-0.5 font-mono text-[0.625rem] capitalize transition-colors duration-150',
                    top === (pos === 'top') ? 'bg-[var(--surface-glass-2)] text-brand' : 'text-ink-3 hover:text-ink-1',
                  )}
                >
                  {pos}
                </button>
              ))}
            </div>
          </div>

          {/* background toggle */}
          <button
            type="button"
            onClick={() => setBg((b) => !b)}
            aria-pressed={bg}
            className={cn(
              'rounded-chip border px-2.5 py-1 font-mono text-[0.625rem] tracking-[0.06em] transition-colors duration-150',
              bg ? 'border-line-strong bg-[var(--surface-glass-2)] text-brand' : 'border-line text-ink-3 hover:text-ink-1',
            )}
          >
            BG {bg ? 'on' : 'off'}
          </button>
        </div>

        <div className="flex items-center justify-end gap-3">
          <button
            type="button"
            onClick={reset}
            className="flex items-center gap-1.5 font-mono text-[0.6875rem] tracking-[0.04em] text-ink-3 transition-colors hover:text-ink-1"
          >
            <RotateCcw className="h-3 w-3" />
            reset
          </button>
        </div>
      </div>
    </Stage>
  );
}
