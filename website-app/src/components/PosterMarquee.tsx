import { cn } from '@/lib/utils';
import { asset } from '@/lib/asset';

const POSTERS = Array.from({ length: 8 }, (_, i) => asset(`poster-0${i + 1}.jpg`));

interface PosterMarqueeProps {
  className?: string;
  /** tilt rows -4deg (default true) */
  tilt?: boolean;
}

/**
 * PosterMarquee - infinite CSS marquee of fictional poster thumbs.
 * Two rows, opposite directions (46s / 62s), mask-faded edges, -4deg tilt.
 * Hover: pauses, hovered card scales 1.06 + glows.
 */
export default function PosterMarquee({ className, tilt = true }: PosterMarqueeProps) {
  const rowA = POSTERS;
  const rowB = [...POSTERS].reverse();

  const renderRow = (posters: string[], reverse: boolean) => (
    <div className="marquee" key={reverse ? 'b' : 'a'}>
      <div className={cn('marquee-track gap-4 pr-4', reverse && 'marquee-track-reverse')}>
        {[...posters, ...posters].map((src, i) => (
          <div
            key={`${src}-${i}`}
            className="relative w-[110px] shrink-0 overflow-hidden rounded-xl border border-line transition-[transform,box-shadow] duration-300 ease-expo hover:z-10 hover:scale-[1.06] hover:shadow-glow-brand md:w-[140px]"
          >
            <img
              src={src}
              alt=""
              loading="lazy"
              className="aspect-[2/3] w-full object-cover"
              draggable={false}
            />
          </div>
        ))}
      </div>
    </div>
  );

  return (
    <div aria-hidden="true" className={cn('select-none', className)}>
      <div className={cn('flex flex-col gap-4', tilt && 'rotate-[-4deg]')}>{[renderRow(rowA, false), renderRow(rowB, true)]}</div>
    </div>
  );
}
