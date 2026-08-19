import { Route, Routes } from "react-router";
import { AppLayout } from "./components/AppLayout.tsx";
import { NotFoundPage } from "./pages/NotFoundPage.tsx";
import { SearchPage } from "./pages/SearchPage.tsx";

//One route carries the whole search experience. The empty state and the results state are
//the same page told apart by `?q=`, which is what makes a result URL shareable and lets the
//back button step through searches instead of leaving the app. The catch-all exists so an
//unknown path is an answer rather than an empty shell.
export default function App() {
  return (
    <Routes>
      <Route element={<AppLayout />}>
        <Route index element={<SearchPage />} />
        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
