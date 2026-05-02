"use strict";

const fs = require("fs");
const path = require("path");
const slashpath = require("./slashpath");
const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const fields = ["relpath", "PB", "PW", "BR", "WR", "SZ", "HA", "RE", "DT", "EV", "RO", "dyer", "movecount"];
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

	throw_if_busy("connect");

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

	throw_if_busy("select");
	throw_if_no_db("select");

	work_in_progress = true;
	try {
		return await current_db.select(filter);
	} finally {
		work_in_progress = false;
	}
};

exports.update = async function() {

	throw_if_busy("update");
	throw_if_no_db("update");

	work_in_progress = true;
	abort_flag = false;

	let database = current_db;
	let archivepath = config.sgfdir;
	let missing_files = [];
	let new_files = [];

	try {
		let files = await list_all_files(archivepath, "");

		let db_set = new Set(database.records.map(o => o.relpath));
		let file_set = new Set(files);

		// Make the diffs...

		missing_files = [...db_set].filter(relpath => !file_set.has(relpath));
		missing_files.sort();
		new_files = [...file_set].filter(relpath => !db_set.has(relpath));

		await perform_deletions(database, missing_files, new_files.length);
		let new_records = await perform_additions(database, archivepath, missing_files.length, new_files);
		throw_if_cannot_continue(database, "update");			// Before we save.

		if (missing_files.length > 0 || new_files.length > 0) {
			update_import_status(missing_files.length, missing_files.length, new_files.length, new_files.length);
			await database.save();
		}
		return {additions: new_files.length, deletions: missing_files.length, new_records: new_records}
	} finally {
		work_in_progress = false;
		abort_flag = false;
	}
};

exports.clear = async function() {

	throw_if_busy("clear");
	throw_if_no_db("clear");

	work_in_progress = true;
	try {
		await current_db.clear();
	} finally {
		work_in_progress = false;
	}
};

exports.save = async function() {

	throw_if_busy("save");
	throw_if_no_db("save");

	work_in_progress = true;
	try {
		await current_db.save();
	} finally {
		work_in_progress = false;
	}
};

exports.reimport = async function(relpath) {

	throw_if_busy("reimport");
	throw_if_no_db("reimport");

	if (typeof relpath !== "string" || relpath === "") {
		throw new Error("reimport(): invalid relpath");
	}

	work_in_progress = true;
	try {
		let record = create_record_from_path(config.sgfdir, relpath);		// This can throw.
		let actually_deleted = await current_db.delete_one(relpath);
		if (!actually_deleted) {
			throw new Error("reimport(): couldn't find old record");
		}
		await current_db.add(record);
		await current_db.save();
		return record;
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
						let line = JSON.stringify(records[i++], fields) + "\n";
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
			return false;
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
			return false;
		}
		this.records.splice(idx, 1);
		this.delete_hint = idx;
		return true;
	},

}

// ------------------------------------------------------------------------------------------------

function record_matches(rec, filter) {
	let p1 = filter.P1;
	let p2 = filter.P2;

	if (p1 && p2) {
		let pb = rec.PB.toLowerCase();
		let pw = rec.PW.toLowerCase();
		let p1_lower = p1.toLowerCase();
		let p2_lower = p2.toLowerCase();
		let fwd = pb.includes(p1_lower) && pw.includes(p2_lower);
		let rev = pb.includes(p2_lower) && pw.includes(p1_lower);
		if (!fwd && !rev) {
			return false;
		}
	} else if (p1) {
		let p1_lower = p1.toLowerCase();
		if (!rec.PB.toLowerCase().includes(p1_lower) && !rec.PW.toLowerCase().includes(p1_lower)) {
			return false;
		}
	} else if (p2) {
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
		update_import_status(0, missing_files.length, 0, new_files_total);
		await yield_to_gui();
	}

	for (let relpath of missing_files) {

		await database.delete_one(relpath);
		deletions_done++;

		if (deletions_done % DELETION_BATCH_SIZE === 0) {
			throw_if_cannot_continue(database, "perform_deletions");
			update_import_status(deletions_done, missing_files.length, 0, new_files_total);
			await yield_to_gui();
		}
	}
}

async function perform_additions(database, archivepath, missing_files_total, new_files) {

	let new_records = [];
	let additions_done = 0;

	if (new_files.length > 0) {
		update_import_status(missing_files_total, missing_files_total, 0, new_files.length);
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
			throw_if_cannot_continue(database, "perform_additions");
			update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length);
			await yield_to_gui();
		}
	}

	return new_records;
}

function throw_if_cannot_continue(database, caller = "some_function") {
	if (database !== current_db) {
		throw new Error(`${caller}(): database changed unexpectedly`);
	}
	if (abort_flag) {
		throw new Error(`${caller}(): aborted by user`);
	}
}

function throw_if_busy(caller = "some_function") {
	if (work_in_progress) {
		throw new Error(`${caller}(): work was in progress`);
	}
}

function throw_if_no_db(caller = "some_function") {
	if (!current_db) {
		throw new Error(`${caller}(): no database`);
	}
}

function update_status(msg) {
	let el = document.getElementById("status");
	if (el) {
		el.textContent = msg;
	}
}

function update_import_status(deletions_done, deletions_total, additions_done, additions_total) {
	update_status(`Updating database - deletions: ${deletions_done}/${deletions_total}, additions: ${additions_done}/${additions_total}`);
}

function yield_to_gui() {
	return new Promise(resolve => {
		requestAnimationFrame(() => {
			setTimeout(resolve, 0);
		});
	});
}
