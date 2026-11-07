/** Pi owns models.json, credentials, configuration composition and chat dispatch. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createChameleonExtension } from "./discovery/lifecycle.ts";

export { createChameleonExtension } from "./discovery/lifecycle.ts";

/** Keep the native Pi extension factory entry point compatible with CLI/jiti loading. */
export default function chameleon(pi: ExtensionAPI): void | Promise<void> {
	return createChameleonExtension()(pi);
}
