import { createFileRoute } from "@tanstack/react-router";
import { ChangesView } from "../components/Changes.tsx";

export const Route = createFileRoute("/s/$id_/changes")({ component: Page });

function Page() {
	const { id } = Route.useParams();
	return <ChangesView key={id} id={Number(id)} />;
}
