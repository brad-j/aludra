import { createFileRoute } from "@tanstack/react-router";
import { SessionView } from "../components/Session.tsx";

export const Route = createFileRoute("/s/$id")({ component: Page });

function Page() {
	const { id } = Route.useParams();
	return <SessionView key={id} id={Number(id)} />;
}
