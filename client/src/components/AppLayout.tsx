import { Link, Outlet } from "react-router";

export function AppLayout() {
  return (
    <div className="flex min-h-svh flex-col bg-bg font-sans text-text">
      <header className="border-b border-border">
        <div className="mx-auto flex w-full max-w-3xl items-center px-4 py-4">
          <Link
            to="/"
            className="font-medium tracking-tight text-heading transition-colors hover:text-accent"
          >
            Search Engine
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <Outlet />
      </main>

      <footer className="border-t border-border">
        <p className="mx-auto w-full max-w-3xl px-4 py-4 text-sm">
          Custom crawler, inverted index and BM25 ranking.
        </p>
      </footer>
    </div>
  );
}
