"use strict";

const fs = require("fs");
const path = require("path");
const slashpath = require("./slashpath");
const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const fields = ["relpath", "dyer", "movecount", "SZ", "HA", "PB", "PW", "BR", "WR", "RE", "DT", "EV", "RO"];
const DELETION_BATCH_SIZE = 43;
const ADDITION_BATCH_SIZE = 47;

let current_db = null;
let work_in_progress = false;
let abort_flag = false;

exports.connected = function() {
	return Boolean(current_db);
};

exports.wip = function() {
	return work_in_progress;
};

exports.count = function() {
	if (current_db) {
		return current_db.records.length;
	} else {
		return 0;
	}
};

exports.stop_update = function() {
	if (work_in_progress) {
		abort_flag = true;
	}
};

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
	return results;
};

exports.update = async function() {

	if (work_in_progress) {
		return Promise.reject(new Error("update(): Work is in progress."));
	}
	if (!current_db) {
		return Promise.reject(new Error("update(): No database."));
	}

	work_in_progress = true;
	abort_flag = false;

	let database = current_db;
	let archivepath = config.sgfdir;
	let missing_files = [];
	let new_files = [];
	let new_records = [];

	let files = await list_all_files(archivepath, "");

	let db_set = Object.create(null);
	let file_set = Object.create(null);

	for (let f of files) {
		file_set[f] = true;
	}

	for (let o of current_db.records) {
		db_set[o.relpath] = true;
	}

	// Make the diffs...

	for (let key of Object.keys(db_set)) {
		if (!file_set[key]) {
			missing_files.push(key);
		}
	}
	missing_files.sort();
	for (let key of Object.keys(file_set)) {
		if (!db_set[key]) {
			new_files.push(key);
		}
	}

	try {
		await perform_deletions(database, missing_files, new_files.length);
		await perform_additions(database, archivepath, missing_files.length, new_files, new_records);
		throw_if_cannot_continue(database);			// Before we save.

		if (missing_files.length > 0 || new_files.length > 0) {
			update_import_status(missing_files.length, missing_files.length, new_files.length, new_files.length, "saving");
			await database.save();
		}
	} catch (err) {
		throw err;
	} finally {
		work_in_progress = false;
		abort_flag = false;
	}

	return {additions: new_files.length, deletions: missing_files.length, new_records: new_records}
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
	try {
		await current_db.save();
	} finally {
		work_in_progress = false;
	}
};


// ------------------------------------------------------------------------------------------------

async function new_db(filepath) {
	let db = Object.create(db_prototype);
	await db.init(filepath);
	return db;
}

const db_prototype = {

	init: async function(filepath) {
		this.records = [];
		this.filepath = filepath;
		this.delete_hint = 0;
		await this.load(filepath);
	},

	load: async function(filepath) {
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

		let n = this.records.length;
		if (n === 0) {
			return;
		}
		if (this.delete_hint >= n) {
			this.delete_hint = 0;
		}
		let idx = -1;
		for (let i = 0; i < n; i++) {
			let j = (this.delete_hint + i) % n;
			if (this.records[j].relpath === relpath) {
				idx = j;
				break;
			}
		}
		if (idx < 0) {
			return;
		}
		this.records.splice(idx, 1);
		this.delete_hint = idx;
	},

}

// ------------------------------------------------------------------------------------------------

function record_matches(rec, filter) {
	for (let key of Object.keys(filter)) {
		let val = filter[key].toLowerCase();
		if (key === "P1" || key === "P2") {
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

async function perform_deletions(database, missing_files, new_files_total) {

	let batch_promises = [];
	let deletions_done = 0;

	if (missing_files.length > 0) {
		update_import_status(0, missing_files.length, 0, new_files_total, "deleting");
	}

	for (let relpath of missing_files) {

		batch_promises.push(database.deleteone(relpath));

		if (batch_promises.length >= DELETION_BATCH_SIZE) {
			await Promise.all(batch_promises);
			throw_if_cannot_continue(database);
			deletions_done += batch_promises.length;
			update_import_status(deletions_done, missing_files.length, 0, new_files_total, "deleting");
			batch_promises = [];
		}
	}

	if (batch_promises.length > 0) {
		await Promise.all(batch_promises);
		throw_if_cannot_continue(database);
		deletions_done += batch_promises.length;
		update_import_status(deletions_done, missing_files.length, 0, new_files_total, "deleting");
	}
}

async function perform_additions(database, archivepath, missing_files_total, new_files, new_records) {

	let batch_promises = [];
	let additions_done = 0;

	if (new_files.length > 0) {
		update_import_status(missing_files_total, missing_files_total, 0, new_files.length, "adding");
	}

	for (let relpath of new_files) {
		let record;
		try {
			record = create_record_from_path(archivepath, relpath);
		} catch (err) {
			console.log(relpath, err);
			continue;
		}
		batch_promises.push(database.add(record));
		new_records.push(record);

		if (batch_promises.length >= ADDITION_BATCH_SIZE) {
			await Promise.all(batch_promises);
			throw_if_cannot_continue(database);
			additions_done += batch_promises.length;
			update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length, "adding");
			batch_promises = [];
		}
	}

	if (batch_promises.length > 0) {
		await Promise.all(batch_promises);
		throw_if_cannot_continue(database);
		additions_done += batch_promises.length;
		update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length, "adding");
	}
}

function throw_if_cannot_continue(database) {
	if (database !== current_db) {
		throw new Error(`database changed unexpectedly`);
	}
	if (abort_flag) {
		throw new Error(`aborted by user`);
	}
}

function update_status(msg) {
	let el = document.getElementById("status");
	if (el) {
		el.innerHTML = msg;
	}
}

function update_import_status(deletions_done, deletions_total, additions_done, additions_total, phase) {
	update_status(`Updating database (${phase}) - deletions: ${deletions_done}/${deletions_total}, additions: ${additions_done}/${additions_total}`);
}
