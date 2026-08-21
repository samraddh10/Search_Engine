
const PLACEHOLDER_COUNT = 3;

export function ResultsSkeleton() {
  return (
    <div aria-hidden="true" className="flex animate-pulse flex-col gap-8">
      {Array.from({ length: PLACEHOLDER_COUNT }, (_, index) => (
        <div key={index} className="flex flex-col gap-2">
          <div className="h-5 w-2/3 rounded bg-border" />
          <div className="h-3 w-1/3 rounded bg-border" />
          <div className="h-4 w-full rounded bg-border" />
          <div className="h-4 w-5/6 rounded bg-border" />
        </div>
      ))}
    </div>
  );
}
