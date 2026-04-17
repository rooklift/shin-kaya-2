"use strict";

const fs = require("fs");
const slashpath = require("./slashpath");
const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const fields = ["relpath", "dyer", "movecount", "SZ", "HA", "PB", "PW", "BR", "WR", "RE", "DT", "EV", "RO"];

let current_db = null;
let work_in_progress = false;
let abort_flag = false;

exports.current = function() {
	// FIXME - probably factor this out.
};

exports.wip = function() {
	return work_in_progress;
};

exports.connect = async function() {

	if (work_in_progress) {
		throw new Error("connect() called while work in progress");
	}

	current_db = null;

	if (typeof config.sgfdir !== "string" || !fs.existsSync(config.sgfdir)) {
		config.sgfdir = null;
		return;
	}

	work_in_progress = true;
	current_db = await new_db(slashpath.join(config.sgfdir, ".shin-kaya-2.jsonl"));
};

async function new_db(filepath) {
	let db = Object.create(db_prototype);
	return await db.init(filepath);			// Is "return await" right?
}

const db_prototype = {

	init: async function(filepath) {
		this.records = [];
		this.filepath = filepath;
		this.delete_hint = 0;

		// FIXME - load the records from the file, if present, and sort.
	},

	load: async function() {
		let data = await fs.promises.readFile(filepath, "utf8");
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
			let msg = validate_record(rec);
			if (msg) {
				throw new Error(`${msg} on line ${n + 1}`);
			}
			temp.push(rec);
		}
		this.records = temp;
		this.delete_hint = 0;
		this.sort();
		return {count: this.records.length};
	},

	sort: function() {
		this.records.sort((a, b) => {
			if (a.relpath < b.relpath) return -1;
			if (a.relpath > b.relpath) return 1;
			return 0;
		});
	},

	save: async function() {
		let dir = path.dirname(this.filepath);
		let temp_path = path.join(dir, `simpledb-${process.pid}-${Date.now()}.jsonl.tmp`);

		let parts = [];
		for (let rec of this.records) {
			parts.push(JSON.stringify(rec));
			parts.push("\n");
		}
		let content = parts.join("");
		try {
			await fs.promises.writeFile(temp_path, content);
			await fs.promises.rename(temp_path, state.filepath);
			return;
		} catch (err) {
			fs.promises.unlink(temp_path).catch(() => {});
			throw err;
		}
	},

	add: function(rec) {
		let msg = validate_record(state, rec);
		if (msg) {
			throw new Error(msg);
		}
		let val = rec.relpath;
		let lo = 0;
		let hi = state.records.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if (state.records[mid].relpath < val) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		state.records.splice(lo, 0, rec);
	},

	select: function(o) {






}

function validate_record(rec) {
	if (typeof rec !== "object" || rec === null || Array.isArray(rec)) {
		return "record must be an object";
	}
	for (let f of fields) {
		if (!Object.prototype.hasOwnProperty.call(rec, f)) {
			return `missing field: ${f}`;
		}
		if (typeof rec[f] !== "string") {
			return `field ${f} must be a string`;
		}
	}
	for (let k of Object.keys(rec)) {
		if (!fields.includes(k)) {
			return `unexpected field: ${k}`;
		}
	}
	return "";
}