import { LobbyDurableObject } from "./lobby.js";

export default {
	/**
	 * @param {Request} request
	 * @param {{ LOBBY_DO: DurableObjectNamespace }} env
	 */
	async fetch(request, env) {
		const upgrade = request.headers.get("Upgrade");
		if (!upgrade || upgrade.toLowerCase() !== "websocket") {
			return new Response("Noname lobby", { status: 200 });
		}
		const id = env.LOBBY_DO.idFromName("lobby");
		return env.LOBBY_DO.get(id).fetch(request);
	},
};

export { LobbyDurableObject };
