/**
 * Starting points for someone who has never seen this corpus.
 *
 * A search box over an unknown corpus is a prompt with no context: a first-time visitor types
 * something generic, matches nothing, and concludes the engine is broken rather than that they
 * guessed outside it. Autocomplete does not rescue that — it only helps once you have typed a
 * letter worth completing, and it cannot tell you the corpus is about web and Python
 * documentation. One click can.
 *
 * The list is **hardcoded, not derived**, and that is the point. A frequency-ranked term from
 * the index would surface `content` or `value` — accurate, useless as a demonstration. These
 * are chosen so each one shows the engine doing something specific, which is what makes them
 * worth a click rather than filler.
 *
 * They write the URL through the callback rather than reaching for `useSearchUrl` themselves,
 * so `SearchPage` stays the one place that decides what submitting means — the same rule 4.3
 * set when it made `useSearchUrl` the only writer of `?q=`.
 */
export interface ExampleQueriesProps {
  onSelect: (query: string) => void;
}

interface Example {
  query: string;
  /** What this query demonstrates. Shown as the button's accessible description. */
  shows: string;
}

const EXAMPLES: Example[] = [
  { query: "closure scope", shows: "ranking — the reference page for the concept wins" },
  { query: "async await", shows: "one query answered across React and MDN" },
  { query: "flexbox", shows: "CSS layout documentation" },
  { query: "asyncio", shows: "the Python standard library" },
  { query: "useEffect", shows: "React reference and guides" },
];

export function ExampleQueries({ onSelect }: ExampleQueriesProps) {
  return (
    <div className="flex flex-col gap-2">
      <p className="text-sm text-text">Try one of these:</p>

      <ul className="flex flex-wrap gap-2">
        {EXAMPLES.map((example) => (
          <li key={example.query}>
            <button
              type="button"
              onClick={() => onSelect(example.query)}
              //The visible label is the query alone — short enough to scan five of them. What
              //it demonstrates rides on the title for a pointer and the accessible name for a
              //screen reader, so neither has to read a paragraph to choose one.
              title={example.shows}
              aria-label={`Search for ${example.query} — ${example.shows}`}
              className="rounded-full border border-border px-3 py-1.5 text-sm text-heading transition-colors hover:border-accent-border hover:bg-accent-bg hover:text-accent"
            >
              {example.query}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
