/**
 * Page controls for a result set.
 *
 * Writes nothing itself: `onPageChange` is `useSearchUrl`'s `goToPage`, which is the only
 * writer of `?page=` in the app. Two components each calling `setSearchParams` is how a new
 * search inherits the old one's offset, and keeping this one a pure callback is half of why
 * that cannot happen.
 */
export interface PaginationProps {
  /** 1-based. */
  page: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}

/** Pages shown on each side of the current one before the list elides. */
const WINDOW_SPAN = 2;

export function Pagination({ page, totalPages, onPageChange }: PaginationProps) {
  if (totalPages <= 1) return null;

  return (
    <nav aria-label="Search results pages" className="flex flex-wrap items-center gap-1">
      <button
        type="button"
        onClick={() => onPageChange(page - 1)}
        disabled={page <= 1}
        className="rounded px-3 py-2 text-sm text-accent hover:bg-accent-bg disabled:text-text disabled:hover:bg-transparent"
      >
        Previous
      </button>

      {pageSlots(page, totalPages).map((slot, index) =>
        slot === GAP ? (
          <span key={`gap-${index}`} aria-hidden="true" className="px-2 py-2 text-sm text-text">
            …
          </span>
        ) : (
          <button
            key={slot}
            type="button"
            onClick={() => onPageChange(slot)}
            //What tells a screen reader which page it is on. The button stays enabled: it
            //is a no-op, and disabling it would remove it from the tab order mid-list.
            aria-current={slot === page ? "page" : undefined}
            className={
              slot === page
                ? "rounded bg-accent-bg px-3 py-2 text-sm font-medium text-accent"
                : "rounded px-3 py-2 text-sm text-text hover:bg-accent-bg hover:text-accent"
            }
          >
            {slot}
          </button>
        ),
      )}

      <button
        type="button"
        onClick={() => onPageChange(page + 1)}
        disabled={page >= totalPages}
        className="rounded px-3 py-2 text-sm text-accent hover:bg-accent-bg disabled:text-text disabled:hover:bg-transparent"
      >
        Next
      </button>
    </nav>
  );
}

const GAP = Symbol("gap");
type PageSlot = number | typeof GAP;

/**
 * The first page, the last page, a window around the current one, and `…` for what is left
 * out — so the control stays one line wide on a corpus with a hundred pages.
 *
 * A gap that would hide exactly one page renders that page instead: `1 … 3` is the same
 * width as `1 2 3` and tells the reader less.
 */
function pageSlots(page: number, totalPages: number): PageSlot[] {
  const shown = new Set<number>([1, totalPages]);

  for (let candidate = page - WINDOW_SPAN; candidate <= page + WINDOW_SPAN; candidate++) {
    if (candidate >= 1 && candidate <= totalPages) shown.add(candidate);
  }

  const slots: PageSlot[] = [];
  let previous = 0;

  for (const current of [...shown].sort((a, b) => a - b)) {
    if (current - previous === 2) slots.push(current - 1);
    else if (current - previous > 2) slots.push(GAP);

    slots.push(current);
    previous = current;
  }

  return slots;
}
