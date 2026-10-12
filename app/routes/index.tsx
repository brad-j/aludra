import { createFileRoute } from "@tanstack/react-router";
import { NewSession } from "../components/NewSession.tsx";

export const Route = createFileRoute("/")({ component: NewSession });
