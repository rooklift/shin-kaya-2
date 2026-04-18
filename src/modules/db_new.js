"use strict";

const fs = require("fs");
const path = require("path");
const slashpath = require("./slashpath");
const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const fields = ["relpath", "dyer", "movecount", "SZ", "HA", "PB", "PW", "BR", "WR", "RE", "DT", "EV", "RO"];
const sorted_fields = [...fields].sort();			// Used as a JSON.stringify replacer in save(), to normalise key order on disk.
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
	try {
		current_db = await new_db(slashpath.join(config.sgfdir, ".shin-kaya-2.jsonl"));
	} finally {
		work_in_progress = false;
	}
};

exports.select = async function(filter) {
	if (work_in_progress) {
		throw new Error("select(): work was in progress");
	}
	if (!current_db) {
		throw new Error("select(): no database");
	}
	work_in_progress = true;
	try {
		return await current_db.select(filter);
	} finally {
		work_in_progress = false;
	}
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

	try {
		let files = await list_all_files(archivepath, "");

		let db_set = Object.create(null);
		let file_set = Object.create(null);

		for (let f of files) {
			file_set[f] = true;
		}

		for (let o of database.records) {
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

		await perform_deletions(database, missing_files, new_files.length);
		let new_records = await perform_additions(database, archivepath, missing_files.length, new_files);
		throw_if_cannot_continue(database);			// Before we save.

		if (missing_files.length > 0 || new_files.length > 0) {
			update_import_status(missing_files.length, missing_files.length, new_files.length, new_files.length, "saving");
			await database.save();
		}
		return {additions: new_files.length, deletions: missing_files.length, new_records: new_records}
	} finally {
		work_in_progress = false;
		abort_flag = false;
	}
};

exports.clear = async function() {
	if (work_in_progress) {
		throw new Error("clear(): work in progress");
	}
	if (!current_db) {
		throw new Error("clear(): no database");
	}
	work_in_progress = true;
	try {
		await current_db.clear();
	} finally {
		work_in_progress = false;
	}
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
		let data;
		try {
			data = await fs.promises.readFile(filepath, "utf8");
		} catch (err) {
			if (err.code === "ENOENT") {
				this.records = [];
				this.delete_hint = 0;
				return;
			}
			throw err;
		}
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
		let records = this.records;

		try {
			await new Promise((resolve, reject) => {
				let stream = fs.createWriteStream(temp_path);
				let i = 0;

				stream.on("error", reject);

				function write_next() {
					while (i < records.length) {
						let line = JSON.stringify(records[i], sorted_fields) + "\n";
						i++;
						if (!stream.write(line)) {
							stream.once("drain", write_next);
							return;
						}
					}
					stream.end(resolve);					// Fires resolve on "finish", after the OS flush.
				}

				write_next();
			});
			await fs.promises.rename(temp_path, this.filepath);
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

	delete_one: async function(relpath) {

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
	let p1 = filter.P1;
	let p2 = filter.P2;

	if (typeof p1 === "string" && typeof p2 === "string") {
		let pb = rec.PB.toLowerCase();
		let pw = rec.PW.toLowerCase();
		let p1_lower = p1.toLowerCase();
		let p2_lower = p2.toLowerCase();
		let fwd = pb.includes(p1_lower) && pw.includes(p2_lower);
		let rev = pb.includes(p2_lower) && pw.includes(p1_lower);
		if (!fwd && !rev) {
			return false;
		}
	} else if (typeof p1 === "string") {
		let p1_lower = p1.toLowerCase();
		if (!rec.PB.toLowerCase().includes(p1_lower) && !rec.PW.toLowerCase().includes(p1_lower)) {
			return false;
		}
	} else if (typeof p2 === "string") {
		let p2_lower = p2.toLowerCase();
		if (!rec.PB.toLowerCase().includes(p2_lower) && !rec.PW.toLowerCase().includes(p2_lower)) {
			return false;
		}
	}

	for (let key of Object.keys(filter)) {
		if (key === "P1" || key === "P2") {
			continue;
		}
		let val = filter[key].toLowerCase();
		if (!rec[key].toLowerCase().includes(val)) {
			return false;
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

	let deletions_done = 0;

	if (missing_files.length > 0) {
		update_import_status(0, missing_files.length, 0, new_files_total, "deleting");
		await yield_to_gui();
	}

	for (let relpath of missing_files) {

		await database.delete_one(relpath);
		deletions_done++;

		if (deletions_done % DELETION_BATCH_SIZE === 0) {
			throw_if_cannot_continue(database);
			update_import_status(deletions_done, missing_files.length, 0, new_files_total, "deleting");
			await yield_to_gui();
		}
	}

	if (deletions_done % DELETION_BATCH_SIZE !== 0) {
		throw_if_cannot_continue(database);
		update_import_status(deletions_done, missing_files.length, 0, new_files_total, "deleting");
		await yield_to_gui();
	}
}

async function perform_additions(database, archivepath, missing_files_total, new_files) {

	let new_records = [];
	let additions_done = 0;

	if (new_files.length > 0) {
		update_import_status(missing_files_total, missing_files_total, 0, new_files.length, "adding");
		await yield_to_gui();
	}

	for (let relpath of new_files) {
		let record;
		try {
			record = create_record_from_path(archivepath, relpath);
		} catch (err) {
			console.log(relpath, err);
			continue;
		}
		await database.add(record);
		new_records.push(record);
		additions_done++;

		if (additions_done % ADDITION_BATCH_SIZE === 0) {
			throw_if_cannot_continue(database);
			update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length, "adding");
			await yield_to_gui();
		}
	}

	if (additions_done % ADDITION_BATCH_SIZE !== 0) {
		throw_if_cannot_continue(database);
		update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length, "adding");
		await yield_to_gui();
	}

	return new_records;
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

function yield_to_gui() {
	return new Promise(resolve => {
		if (typeof requestAnimationFrame === "function") {
			requestAnimationFrame(() => resolve());
		} else {
			setTimeout(resolve, 0);
		}
	});
}
