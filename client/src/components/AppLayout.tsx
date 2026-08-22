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
            wisp
          </Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-3xl flex-1 px-4 py-10">
        <Outlet />
      </main>

      {/*
        What it is on the left, who made it on the right. `flex-wrap` rather than a media
        query, so the two stack onto separate lines on a narrow screen instead of being
        squeezed together — the only responsive behaviour this row needs.
      */}
      <footer className="border-t border-border">
        <div className="mx-auto flex w-full max-w-3xl flex-wrap items-center justify-between gap-x-4 gap-y-1 px-4 py-4 text-sm">
          <p>Custom crawler, inverted index and BM25 ranking.</p>

          <p>
            Built by Samraddh ·{" "}
            <a
              href="https://github.com/samraddh10"
              //An external profile, so it opens alongside the app rather than replacing it.
              //`noopener` matters: without it the opened page gets a handle back into this one.
              target="_blank"
              rel="noopener noreferrer"
              className="rounded text-accent hover:underline"
            >
              GitHub
              {/* A link that behaves differently should say so to anyone who cannot see it. */}
              <span className="sr-only"> (opens in a new tab)</span>
            </a>
          </p>
        </div>
      </footer>
    </div>
  );
}
