#!/usr/bin/env node
/**
 * The developer's command line for a local controller.
 *
 * Not the container's entry point — that is `local-rpc-server.mjs`, and none of
 * this runs in the cloud. It is how a person on their own machine signs a
 * profile in, sends it one prompt, asks what its container is doing, or stops
 * it. It lived in the turn plan's file, so every reader of the turn plan opened
 * an argument parser first, and the image shipped a CLI it never invokes.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { login, readProfile } from "./local-profile.mjs";
import { prompt } from "./local-rpc-controller.mjs";
import { findOwnedContainer, resourcesFor } from "./runtime-docker.mjs";
import { validateProfileName } from "./runtime-identity.mjs";
import { idleContainers } from "./runtime-warm-process.mjs";

async function status(profileName) {
	const profile = validateProfileName(profileName);
	const metadata = readProfile(profile);
	const resources = resourcesFor(profile);
	const container = await findOwnedContainer(profile);
	console.log(
		JSON.stringify(
			{
				profile,
				userId: metadata.userId,
				companyId: metadata.companyId,
				backendUrl: metadata.backendUrl,
				resources,
				container: container ? container.State.Status : "missing",
			},
			null,
			2,
		),
	);
}

export function parseArguments(argv) {
	const positional = [];
	const options = {};
	for (let index = 0; index < argv.length; index += 1) {
		const value = argv[index];
		if (!value.startsWith("--")) {
			positional.push(value);
			continue;
		}
		const key = value.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
		if (["approve", "noBrowser", "replaceProfile"].includes(key)) {
			options[key === "noBrowser" ? "browser" : key] = key === "noBrowser" ? false : true;
			continue;
		}
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) throw new Error(`${value} requires a value`);
		options[key] = next;
		index += 1;
	}
	return { positional, options };
}

export async function main(argv = process.argv.slice(2)) {
	const { positional, options } = parseArguments(argv);
	const [command, profile, ...rest] = positional;
	if (command === "login") return login(profile, options);
	if (command === "prompt") {
		if (rest.length === 0) throw new Error("prompt requires a message");
		return prompt(profile, rest.join(" "), options);
	}
	if (command === "status") return status(profile);
	if (command === "stop") return idleContainers.stopNow(validateProfileName(profile));
	throw new Error(
		[
			"Usage:",
			"  node divo/local-controller-cli.mjs login <profile> --backend <url> [--department <id>] [--no-browser]",
			"  node divo/local-controller-cli.mjs prompt <profile> --thread <id> [--approve] <message>",
			"  node divo/local-controller-cli.mjs status <profile>",
			"  node divo/local-controller-cli.mjs stop <profile>",
		].join("\n"),
	);
}

const isMain =
	process.argv[1] &&
	path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) {
	main().catch((error) => {
		console.error(`[divo-controller] ${error.message}`);
		process.exitCode = 1;
	});
}
