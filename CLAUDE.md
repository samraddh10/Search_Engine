# Search Engine 2

# Project Overview

This project is a full-stack search engine built from scratch using Node.js, TypeScript, PostgreSQL, Redis, and React. The goal is to understand and implement the core components of a modern search engine rather than relying on existing search platforms like Elasticsearch or Solr.

The system crawls web pages starting from a set of seed URLs, extracts and processes textual content, builds an inverted index, and ranks search results using custom implementations of TF-IDF and BM25. Users can search indexed documents through a REST API and a React-based frontend that supports autocomplete, highlighted search terms, and cached query results.

The project emphasizes modular design, scalability, and clean separation of responsibilities. Every major search engine component—including crawling, indexing, ranking, caching, and query processing—is implemented as an independent module that can be developed, tested, and extended separately.

This project is intended as both a learning exercise in Information Retrieval (IR) and a production-quality portfolio project demonstrating backend engineering, database design, distributed systems concepts, and full-stack web development.

# Project Plan

The full phased implementation plan — architecture diagram, data model, and each
phase's subphases/dependencies/key decisions — lives in `docs/project-plan.md`. It
has a **Status** section at the top tracking which phases are actually done; check
it before assuming what exists.

# Core Features

- Distributed-style web crawler with configurable concurrency
- robots.txt compliance
- Frontier queue and visited URL deduplication
- HTML parsing and content extraction
- Tokenization, stopword removal, and stemming
- Custom inverted index implementation
- PostgreSQL-backed document and index storage
- Custom TF-IDF and BM25 ranking algorithms
- Search result highlighting and snippet generation
- Redis-powered caching
- Autocomplete suggestions
- REST API built with Express
- React frontend
- Comprehensive unit and integration testing

Node.js + TypeScript monorepo using npm workspaces.


# Architecture Components

## 1. Web Crawler

Responsible for discovering and downloading web pages.

**Responsibilities:** Crawl websites from seed URLs, respect `robots.txt`, manage the crawl frontier, limit concurrency, extract links, store raw documents.

**Technologies:** Node.js, TypeScript, Axios/Fetch, Cheerio, robots-parser, p-limit.

---

## 2. Text Processing Pipeline

Converts raw HTML into searchable text.

**Responsibilities:** Remove HTML tags, normalize text, tokenize, remove stopwords, stem words, compute document statistics.

---

## 3. Index Builder

Creates the searchable inverted index.

**Responsibilities:** Calculate term frequencies, calculate document frequencies, build posting lists, maintain document metadata.

**Storage:** PostgreSQL.

---

## 4. Ranking Engine

Computes document relevance scores.

**Algorithms:** TF-IDF, BM25.

**Responsibilities:** Retrieve posting lists, calculate ranking scores, sort results, return ranked document IDs.

---

## 5. Search Service

Processes incoming search requests.

**Responsibilities:** Parse queries, normalize queries, fetch posting lists, invoke the ranking engine, build snippets, highlight matching terms.

---

## 6. Caching Layer

Improves response time for repeated searches.

**Responsibilities:** Cache search results, cache autocomplete prefixes, reduce database load.

**Technology:** Redis.

---

## 7. Backend API

Provides REST endpoints for the frontend.

**Endpoints:** `/search`, `/suggestions`, `/health`, `/statistics`.

**Technology:** Express, TypeScript, Zod, express-rate-limit.

---

## 8. Frontend

Provides the user interface.

**Features:** Search box, autocomplete, highlighted search terms, result snippets, pagination, responsive UI.

**Technology:** React, TypeScript, Tailwind CSS.

---

## 9. Database

**PostgreSQL:** Documents, inverted index, posting lists, document statistics, crawl metadata.

**Redis:** Cached search results, cached autocomplete data, temporary crawler state.

---

# Design Principles

Modular architecture, separation of concerns, custom Information Retrieval algorithms, scalable and extensible design, stateless API layer, efficient database indexing, cache-first query execution, maintainable and testable codebase, production-inspired architecture.

# Important

- Never add `Co-authored-by: Claude` to any commit.
- Never add Claude as a contributor, author, or maintainer.
- Never change Git author information.
- Only create commit messages when explicitly requested by the user.

## Development

Run from the repo root:

- `npm run dev:server` — start the backend with hot reload (tsx watch)
- `npm run dev:client` — start the Vite dev server
- `npm run build` — build both server and client
- `npm run build:server` / `npm run build:client` — build individually

The client dev server proxies `/api/*` requests to `http://localhost:4000`
(configured in `client/vite.config.ts`), so run both `dev:server` and
`dev:client` together during development.

## Conventions

- Server entry point: `server/src/index.ts`
- Client entry point: `client/src/main.tsx`
- Each workspace has its own `package.json` and `tsconfig.json`.
