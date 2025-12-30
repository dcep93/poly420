import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import Poly420 from "./poly420/index.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Poly420 />
  </StrictMode>
);
