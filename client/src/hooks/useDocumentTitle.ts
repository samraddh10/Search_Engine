import { useEffect } from "react";

/** Appended to every page title, and the title of the app's own entry point. */
export const SITE_NAME = "wisp";

export function useDocumentTitle(title: string): void {
  useEffect(() => {
    document.title = title;

    return () => {
      document.title = SITE_NAME;
    };
  }, [title]);
}
