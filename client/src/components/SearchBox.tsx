import { Combobox, ComboboxInput } from "@headlessui/react";
import { useState } from "react";
import type { FormEvent, KeyboardEvent } from "react";
import { MAX_QUERY_LENGTH } from "shared";
import { useSuggestions } from "../hooks/useSuggestions.ts";
import { Suggestions } from "./Suggestions.tsx";


export interface SearchBoxProps {
  query: string;
  onSubmit: (query: string) => void;
}

export function SearchBox({ query, onSubmit }: SearchBoxProps) {
  const [input, setInput] = useState(query);

  const [isEditing, setIsEditing] = useState(false);

  const [lastQuery, setLastQuery] = useState(query);
  if (query !== lastQuery) {
    setLastQuery(query);
    setInput(query);
    setIsEditing(false);
  }

  const { suggestions } = useSuggestions(isEditing ? input : "");

  //Filtered here rather than in `Suggestions`, because the count decides what Enter means
  //and both components cannot own that answer. A suggestion identical to the typed text
  //would also be a second option doing what the first already does, and Headless UI would
  //mark both selected, since both carry the value the combobox holds.
  const completions = suggestions.filter((suggestion) => suggestion.term !== input);

  function runSearch(next: string) {
    //Closes the popover before the URL moves, so the suggestion request for the completed
    //text is never made rather than made and discarded.
    setIsEditing(false);
    onSubmit(next);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    runSearch(input);
  }

  /**
   * Fires when an option is chosen — by click, or by Enter on the active option. Both the
   * suggestions and the typed-text option Headless UI auto-activates arrive here, so this
   * is the single path a "chosen" query takes.
   *
   * The value is typed `string | null` because Headless UI allows clearing a combobox; this
   * one never renders an option with a null value.
   */
  function handleSelect(next: string | null) {
    if (next === null) return;

    setInput(next);
    runSearch(next);
  }

  /**
   * Submits when there is no popover to submit through, and this is a bug fix rather than
   * a nicety — a browser pass caught it, and nothing but a browser would have.
   */
  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key !== "Enter" || completions.length > 0) return;

    event.preventDefault();
    runSearch(input);
  }

  return (
    <form onSubmit={handleSubmit} role="search">
      <Combobox
        as="div"
        className="relative"
        value={input}
        onChange={handleSelect}
        //Escape, an outside click, or a selection. Whatever closed it, we have stopped
        //asking for completions.
        onClose={() => setIsEditing(false)}
      >
        <div className="flex gap-2">
          <ComboboxInput
            type="search"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setIsEditing(true);
            }}
            onKeyDown={handleKeyDown}
            //The server rejects anything longer, so capping it here turns a 400 into a
            //non-event. Imported from `shared`, which is what that workspace is for.
            maxLength={MAX_QUERY_LENGTH}
            //Off, because the browser's own history dropdown would cover the suggestion
            //popover with a second, unrelated list.
            autoComplete="off"
            autoFocus={query === ""}
            placeholder="Search the indexed corpus"
            aria-label="Search query"
            className="w-full flex-1 rounded-lg border border-border bg-transparent px-4 py-3 text-heading outline-none transition-colors placeholder:text-text focus-visible:border-accent-border"
          />

          <button
            type="submit"
            className="shrink-0 rounded-lg border border-accent-border bg-accent-bg px-5 py-3 text-accent transition-colors hover:bg-accent hover:text-bg"
          >
            Search
          </button>
        </div>

        <Suggestions typed={input} completions={completions} />
      </Combobox>
    </form>
  );
}
