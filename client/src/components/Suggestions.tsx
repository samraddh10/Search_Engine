import { ComboboxOption, ComboboxOptions } from "@headlessui/react";
import type { Suggestion } from "shared";


export interface SuggestionsProps {
  typed: string;
  completions: Suggestion[];
}

export function Suggestions({ typed, completions }: SuggestionsProps) {
  if (completions.length === 0) return null;

  return (
    <ComboboxOptions
      //Headless UI defaults `modal` to true, which locks body scroll and marks the rest of
      //the page inert while the popover is open. That is right for a portalled dropdown and
      //wrong for a suggestion list under a search box: the page would become unscrollable
      //and shift by the scrollbar width on every keystroke.
      modal={false}
      className="absolute z-10 mt-2 w-full overflow-hidden rounded-lg border border-border bg-bg py-1 shadow-lg"
    >
      <ComboboxOption
        value={typed}
        className="flex cursor-pointer items-baseline justify-between gap-4 px-4 py-2 text-heading data-focus:bg-accent-bg"
      >
        <span className="truncate">{typed}</span>
        <span className="shrink-0 text-xs text-text">search this text</span>
      </ComboboxOption>

      {/*
        `role="presentation"` and `aria-hidden`, because a listbox's children are supposed to
        be options: a bare `<div>` in here is a node an assistive technology has to decide
        what to do with, and some count it when reporting "2 of 9". It is a line between the
        text you typed and the words the index is offering — decoration, and it says so.
      */}
      <div role="presentation" aria-hidden="true" className="my-1 border-t border-border" />

      {completions.map((suggestion) => (
        <ComboboxOption
          key={suggestion.term}
          value={suggestion.term}
          className="cursor-pointer truncate px-4 py-2 text-heading data-focus:bg-accent-bg"
        >
          {suggestion.term}
        </ComboboxOption>
      ))}
    </ComboboxOptions>
  );
}
