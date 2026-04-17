"use strict";

const fs = require("fs");
const slashpath = require("./slashpath");
const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const fields = ["relpath", "dyer", "movecount", "SZ", "HA", "PB", "PW", "BR", "WR", "RE", "DT", "EV", "RO"];

let current_db = null;
let work_in_progress = false;
let abort_flag = false;

exports.connected = function() {
	return Boolean(current_db);
};

exports.wip = function() {
	return work_in_progress;
};

exports.stop_update = function() {
	if (work_in_progress) {
		abort_flag = true;
	}
}

// Everything below is declared as async on the theory that many things might be
// batched later (yielding to the GUI while they work) or at least it's nice to
// keep things consistent so everything returns promises.

exports.connect = async function() {

	if (work_in_progress) {
		throw new Error("connect(): work was in progress");
	}

	current_db = null;

	if (typeof config.sgfdir !== "string" || !fs.existsSync(config.sgfdir)) {
		config.sgfdir = null;
		return;
	}

	work_in_progress = true;
	current_db = await new_db(slashpath.join(config.sgfdir, ".shin-kaya-2.jsonl"));
	work_in_progress = false;
};

exports.select = async function(filter) {
	if (work_in_progress) {
		throw new Error("select(): work was in progress");
	}
	if (!current_db) {
		throw new Error("select(): no database");
	}
	work_in_progress = true;
	let results = await current_db.select(filter);
	work_in_progress = false;
};

exports.update = async function() {
	if (work_in_progress) {
		throw new Error("update(): work in progress");
	}
	if (!current_db) {
		throw new Error("update(): no database");
	}
	work_in_progress = true;
	// TODO
	work_in_progress = false;
};

exports.clear = async function() {
	if (work_in_progress) {
		throw new Error("clear(): work in progress");
	}
	if (!current_db) {
		throw new Error("clear(): no database");
	}
	work_in_progress = true;
	current_db.clear();
	work_in_progress = false;
};

exports.save = async function() {
	if (work_in_progress) {
		throw new Error("save(): work in progress");
	}
	if (!current_db) {
		throw new Error("save(): no database");
	}
	work_in_progress = true;
	await current_db.save();
	work_in_progress = false;
};


// ------------------------------------------------------------------------------------------------

async function new_db(filepath) {
	let db = Object.create(db_prototype);
	return await db.init(filepath);			// Is "return await" right?
}

const db_prototype = {

	init: async function(filepath) {
		this.records = [];
		this.filepath = filepath;
		this.delete_hint = 0;
		await this.load(filepath);
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
		await this.sort();
		return {count: this.records.length};
	},

	sort: async function() {
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
			await fs.promises.rename(temp_path, this.filepath);
			return;
		} catch (err) {
			fs.promises.unlink(temp_path).catch(() => {});
			throw err;
		}
	},

	add: async function(rec) {
		let msg = validate_record(rec);
		if (msg) {
			throw new Error(msg);
		}
		let val = rec.relpath;
		let lo = 0;
		let hi = this.records.length;
		while (lo < hi) {
			let mid = (lo + hi) >> 1;
			if (this.records[mid].relpath < val) {
				lo = mid + 1;
			} else {
				hi = mid;
			}
		}
		this.records.splice(lo, 0, rec);
	},

	select: async function(filter) {

		let results = [];

		for (let rec of this.records) {
			if (record_matches(rec, filter)) {
				results.push(rec);
			}
		}

		return results;
	},

	clear: async function() {
		this.records = [];
		this.delete_hint = 0;
	},

	deleteone: async function(relpath) {
		// TODO
	},

}

function record_matches(rec, filter) {
	for (let key of Object.keys(filter)) {
		let val = filter[key].toLowerCase();
		if (key === "P1" or key === "P2") {
			if (!rec.PB.toLowerCase().includes(val) && !rec.PW.toLowerCase().includes(val)) {
				return false;
			}
		} else {
			if (!rec[key].toLowerCase().includes(val)) {
				return false;
			}
		}
	}
	return true;
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