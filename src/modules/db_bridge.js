"use strict";

// Some explanation of how the database code ended up in the weird state it's in: in the beginning,
// we used SQLite for the database. But this is awkward to use with Electron, so it occurred to me
// to get Claude to write a simple database program in Golang. This file db_bridge.js used to handle
// the connection via stdin/stdout to that program. Then it occured to me that the operations we
// actually do in the database are ones which Javascript is probably fast enough at, so we now just
// do our database stuff internally. This version of the file was entirely written by Claude.

const fs = require("fs");
const path = require("path");

exports.new_db = function() {

	let state = {
		fields: null,
		records: [],
		filepath: "",
		loaded: false,
		sort_field: "",
		delete_hint: 0,
		shutdown: false,
	};

	// Serialize all commands through a promise chain, so that async I/O
	// (load / save) doesn't interleave with other operations.

	let queue = Promise.resolve();

	return function(cmd) {
		if (state.shutdown) {
			return Promise.reject(new Error("database has shutdown"));
		}
		// Run each command as a macrotask (not a microtask), so the renderer
		// can paint and handle input between commands. This mimics the natural
		// yielding the old IPC-based implementation got for free.
		// The try/catch is needed because a synchronous throw inside the
		// setImmediate callback would otherwise escape as an uncaught exception.
		let p = queue.then(() => new Promise((resolve, reject) => {
			setImmediate(() => {
				try {
					resolve(handle(state, cmd));
				} catch (err) {
					reject(err);
				}
			});
		}));
		queue = p.catch(() => {});
		return p;
	};
};

// ------------------------------------------------------------------------------------------------

function handle(state, cmd) {

	cmd = cmd.trim();
	if (cmd === "") {
		return {};
	}

	if (cmd.startsWith("expect ")) {
		return cmd_expect(state, cmd.slice(7));
	}
	if (cmd.startsWith("load ")) {
		return cmd_load(state, cmd.slice(5).trim());
	}
	if (cmd === "save") {
		return cmd_save(state);
	}
	if (cmd === "quit") {
		state.shutdown = true;
		return {};
	}
	if (cmd.startsWith("add ")) {
		return cmd_add(state, cmd.slice(4));
	}
	if (cmd === "count") {
		if (!state.loaded) throw new Error("no file loaded");
		return {count: state.records.length};
	}
	if (cmd === "clear") {
		if (!state.loaded) throw new Error("no file loaded");
		state.records = [];
		state.delete_hint = 0;
		return {};
	}
	if (cmd.startsWith("sort ")) {
		return cmd_sort(state, cmd.slice(5).trim());
	}
	if (cmd.startsWith("select ")) {
		return cmd_select(state, cmd.slice(7));
	}
	if (cmd.startsWith("deleteone ")) {
		return cmd_deleteone(state, cmd.slice(10));
	}
	if (cmd.startsWith("delete ")) {
		return cmd_delete(state, cmd.slice(7));
	}
	throw new Error("unknown command");
}

// ------------------------------------------------------------------------------------------------

function cmd_expect(state, payload) {
	if (state.fields !== null) {
		throw new Error("fields already set");
	}
	let new_fields = JSON.parse(payload);
	if (!Array.isArray(new_fields)) {
		throw new Error("field list must be an array");
	}
	if (new_fields.length === 0) {
		throw new Error("field list cannot be empty");
	}
	state.fields = new_fields;
	return {};
}

function cmd_load(state, filepath) {
	if (state.fields === null) {
		throw new Error("must call expect first");
	}
	return fs.promises.readFile(filepath, "utf8").then(data => {
		let temp = [];
		let lines = data.split("\n");
		for (let n = 0; n < lines.length; n++) {
			let line = lines[n];
			if (line === "") continue;
			let rec;
			try {
				rec = JSON.parse(line);
			} catch (err) {
				throw new Error(`bad record on line ${n + 1}: ${err.message}`);
			}
			let msg = validate_record(state, rec);
			if (msg) {
				throw new Error(`${msg} on line ${n + 1}`);
			}
			temp.push(rec);
		}
		state.filepath = filepath;
		state.records = temp;
		state.loaded = true;
		state.sort_field = "";
		state.delete_hint = 0;
		return {count: temp.length};
	}, err => {
		if (err.code === "ENOENT") {
			state.filepath = filepath;
			state.records = [];
			state.loaded = true;
			state.sort_field = "";
			state.delete_hint = 0;
			return {count: 0};
		}
		throw err;
	});
}

function cmd_save(state) {
	if (!state.loaded) {
		throw new Error("no file loaded");
	}
	let dir = path.dirname(state.filepath);
	let temp_path = path.join(dir, `simpledb-${process.pid}-${Date.now()}.jsonl.tmp`);

	let parts = [];
	for (let rec of state.records) {
		parts.push(JSON.stringify(rec));
		parts.push("\n");
	}
	let content = parts.join("");

	return fs.promises.writeFile(temp_path, content).then(() => {
		return fs.promises.rename(temp_path, state.filepath);
	}).then(() => {
		return {};
	}).catch(err => {
		fs.promises.unlink(temp_path).catch(() => {});
		throw err;
	});
}

function cmd_add(state, payload) {
	if (!state.loaded) throw new Error("no file loaded");
	let rec = JSON.parse(payload);
	let msg = validate_record(state, rec);
	if (msg) {
		throw new Error(msg);
	}

	if (state.sort_field !== "") {
		let sf = state.sort_field;
		let val = (rec[sf] || "").toLowerCase();
		let lo = 0;
		let hi = state.records.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if ((state.records[mid][sf] || "").toLowerCase() < val) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		state.records.splice(lo, 0, rec);
	} else {
		state.records.push(rec);
	}
	return {};
}

function cmd_sort(state, field) {
	if (!state.loaded) throw new Error("no file loaded");

	// Strip quotes if present...
	if (field.length >= 2 && field[0] === `"` && field[field.length - 1] === `"`) {
		field = field.slice(1, -1);
	}

	if (!is_expected_field(state, field)) {
		throw new Error(`unknown field: ${field}`);
	}

	state.sort_field = field;
	state.delete_hint = 0;

	state.records.sort((a, b) => {
		let av = (a[field] || "").toLowerCase();
		let bv = (b[field] || "").toLowerCase();
		if (av < bv) return -1;
		if (av > bv) return 1;
		return 0;
	});

	return {};
}

function cmd_select(state, payload) {
	if (!state.loaded) throw new Error("no file loaded");
	let pf = parse_filter(state, payload);
	let results = [];
	for (let rec of state.records) {
		if (match_record(rec, pf)) {
			results.push(rec);
		}
	}
	return results;
}

function cmd_deleteone(state, payload) {
	if (!state.loaded) throw new Error("no file loaded");
	let pf = parse_filter(state, payload);

	let n = state.records.length;
	if (n === 0) {
		return {count: 0};
	}
	if (state.delete_hint >= n) {
		state.delete_hint = 0;
	}

	let idx = -1;
	for (let i = 0; i < n; i++) {
		let j = (state.delete_hint + i) % n;
		if (match_record(state.records[j], pf)) {
			idx = j;
			break;
		}
	}

	if (idx < 0) {
		return {count: 0};
	}

	state.records.splice(idx, 1);
	state.delete_hint = idx;
	return {count: 1};
}

function cmd_delete(state, payload) {
	if (!state.loaded) throw new Error("no file loaded");
	let pf = parse_filter(state, payload);

	let count = 0;
	let kept = [];
	for (let rec of state.records) {
		if (match_record(rec, pf)) {
			count++;
		} else {
			kept.push(rec);
		}
	}
	state.records = kept;
	state.delete_hint = 0;
	return {count: count};
}

// ------------------------------------------------------------------------------------------------

function is_expected_field(state, k) {
	for (let f of state.fields) {
		if (f === k) return true;
	}
	return false;
}

function validate_record(state, rec) {
	if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
		return "record must be an object";
	}
	for (let f of state.fields) {
		if (!Object.prototype.hasOwnProperty.call(rec, f)) {
			return `missing field: ${f}`;
		}
		if (typeof rec[f] !== "string") {
			return `field ${f} must be a string`;
		}
	}
	for (let k of Object.keys(rec)) {
		if (!is_expected_field(state, k)) {
			return `unexpected field: ${k}`;
		}
	}
	return "";
}

function parse_filter(state, payload) {
	let raw = JSON.parse(payload);
	if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
		throw new Error("filter must be an object");
	}

	let pf = {
		fields: {},
		pair_keys: null,
		pair_values: null,
	};

	for (let k of Object.keys(raw)) {
		let v = raw[k];
		if (k === "__pair__") {
			if (!Array.isArray(v) || v.length !== 2 || !Array.isArray(v[0]) || !Array.isArray(v[1])) {
				throw new Error("bad __pair__");
			}
			let keys = v[0];
			let values = v[1];
			if (keys.length !== 2) {
				throw new Error("__pair__ must have exactly 2 field names");
			}
			for (let fk of keys) {
				if (!is_expected_field(state, fk)) {
					throw new Error(`unexpected field in __pair__: ${fk}`);
				}
			}
			if (values.length > 2) {
				throw new Error("__pair__ must have 0, 1, or 2 values");
			}
			pf.pair_keys = keys;
			pf.pair_values = values;
			continue;
		}
		if (!is_expected_field(state, k)) {
			throw new Error(`unexpected field: ${k}`);
		}
		if (typeof v !== "string") {
			throw new Error(`bad value for field "${k}"`);
		}
		pf.fields[k] = v;
	}

	return pf;
}

function like_match(haystack, needle) {
	if (typeof haystack !== "string") return false;
	return haystack.toLowerCase().includes(needle.toLowerCase());
}

function match_record(rec, pf) {
	for (let k of Object.keys(pf.fields)) {
		if (!like_match(rec[k], pf.fields[k])) return false;
	}
	if (pf.pair_keys && pf.pair_values.length > 0) {
		let f0 = rec[pf.pair_keys[0]];
		let f1 = rec[pf.pair_keys[1]];
		if (pf.pair_values.length === 1) {
			let v = pf.pair_values[0];
			if (!like_match(f0, v) && !like_match(f1, v)) return false;
		} else {
			let v0 = pf.pair_values[0];
			let v1 = pf.pair_values[1];
			let fwd = like_match(f0, v0) && like_match(f1, v1);
			let rev = like_match(f0, v1) && like_match(f1, v0);
			if (!fwd && !rev) return false;
		}
	}
	return true;
}