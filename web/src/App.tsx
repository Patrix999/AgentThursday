import { BrowserRouter, Route, Routes } from "react-router-dom";
import { SecretGate } from "./auth/SecretGate";
import { Workspace } from "./routes/Workspace";
import { InspectRoute } from "./routes/InspectRoute";

export function App() {
  return (
    <BrowserRouter>
      <SecretGate>
        <Routes>
          <Route path="/" element={<Workspace />} />
          <Route path="/inspect" element={<InspectRoute />} />
          <Route path="*" element={<Workspace />} />
        </Routes>
      </SecretGate>
    </BrowserRouter>
  );
}
