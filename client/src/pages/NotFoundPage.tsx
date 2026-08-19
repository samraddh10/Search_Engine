import { Link } from "react-router";

export function NotFoundPage() {
  return (
    <div className="flex flex-col items-start gap-4">
      <h1 className="text-4xl font-medium tracking-tight text-heading">Not found</h1>
      <p>That page does not exist.</p>
      <Link to="/" className="text-accent hover:underline">
        Back to search
      </Link>
    </div>
  );
}
