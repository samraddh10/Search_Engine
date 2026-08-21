import { Link } from "react-router";
import { SITE_NAME, useDocumentTitle } from "../hooks/useDocumentTitle.ts";

export function NotFoundPage() {
  useDocumentTitle(`Not found — ${SITE_NAME}`);

  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-4xl font-medium tracking-tight text-heading">Not found</h1>
      <p>That page does not exist.</p>
      <Link to="/" className="rounded text-accent hover:underline">
        Back to search
      </Link>
    </div>
  );
}
