"use strict";

const { ipcRenderer, shell } = require("electron");
const { event_path_string } = require("./utils");

// Uncaught exceptions should trigger an alert (once only)...

window.addEventListener("error", (event) => {
	alert("An uncaught exception happened in the renderer process. See the dev console for details. The app might now be in a bad state.");
}, {once: true});

// ------------------------------------------------------------------------------------------------

document.getElementById("searchbutton").addEventListener("click", () => {
	hub.search();
});

document.getElementById("gamesbox").addEventListener("dblclick", (event) => {
	let suffix = event_path_string(event, "gamesbox_entry_");
	if (suffix) {
		let n = parseInt(suffix, 10);
		hub.open_file_from_index(n);
	}
});

document.getElementById("gamesbox").addEventListener("click", (event) => {

	let suffix = event_path_string(event, "gamesbox_entry_");

	if (suffix) {
		let n = parseInt(suffix, 10);
		set_selected_game(n);
	} else {
		set_selected_game(null);
	}
});

document.getElementById("preview").addEventListener("dblclick", () => {
	hub.open_preview_file();
});

document.addEventListener("keydown", (event) => {

	if (event.altKey || event.ctrlKey || event.metaKey) {
		return;
	}

	if (event.target instanceof HTMLInputElement) {
		return;
	}

	let delta = null;

	if (event.code === "ArrowUp") {
		delta = -1;
	} else if (event.code === "ArrowDown") {
		delta = 1;
	} else {
		return;
	}

	let highlighted = document.getElementsByClassName("highlightedgame")[0];

	if (!highlighted) {
		return;
	}

	let prefix = "gamesbox_entry_";

	if (!highlighted.id.startsWith(prefix)) {
		return;
	}

	let n = parseInt(highlighted.id.slice(prefix.length), 10);

	if (Number.isNaN(n)) {
		return;
	}

	event.preventDefault();
	set_selected_game(Math.max(0, Math.min(hub.lookups.length - 1, n + delta)));
});

for (let element of document.querySelectorAll("input")) {
	element.addEventListener("keydown", (event) => {
		if (event.code === "Enter" || event.code === "NumpadEnter") {
			hub.search();
		}
	});
}

// ------------------------------------------------------------------------------------------------

ipcRenderer.on("set", (event, msg) => {
	for (let [key, value] of Object.entries(msg)) {
		hub.set(key, value);
	}
});

ipcRenderer.on("toggle", (event, msg) => {
	hub.set(msg, !config[msg]);
});

ipcRenderer.on("call", (event, msg) => {
	let fn;
	if (typeof msg === "string") {																		// msg is function name
		fn = hub[msg].bind(hub);
	} else if (typeof msg === "object" && typeof msg.fn === "string" && Array.isArray(msg.args)) {		// msg is object with fn and args
		fn = hub[msg.fn].bind(hub, ...msg.args);
	} else {
		console.log("Bad call, msg was...");
		console.log(msg);
	}
	fn();
});

// ------------------------------------------------------------------------------------------------

function set_selected_game(n) {

	// Helper for some of the handlers, above.

	let highlighted = document.getElementsByClassName("highlightedgame")[0];

	if (highlighted) {
		highlighted.className = "";
	}

	if (!Number.isInteger(n) || n < 0 || n >= hub.lookups.length) {
		return;
	}

	hub.set_preview_from_index(n);

	let element_to_highlight = document.getElementById(`gamesbox_entry_${n}`);

	if (element_to_highlight) {
		element_to_highlight.className = "highlightedgame";
		element_to_highlight.scrollIntoView({block: "nearest"});
	}
}