"use strict";

const fs = require("fs");

const bridge = require("./db_bridge");
const slashpath = require("./slashpath");

const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const DELETION_BATCH_SIZE = 5;
const ADDITION_BATCH_SIZE = 47;
const YIELD_AFTER_MS = 25;
const RESUME_DELAY_MS = 5;

let current_db = null;
let work_in_progress = false;
let abort_flag = false;

function update_status(msg) {

	if (typeof document === "undefined") {
		return;
	}

	let el = document.getElementById("status");
	if (el) {
		el.innerHTML = msg;
	}
}

function update_import_status(deletions_done, deletions_total, additions_done, additions_total, phase) {
	update_status(
		`Updating database (${phase}) - deletions: ${deletions_done}/${deletions_total}, additions: ${additions_done}/${additions_total}`
	);
}

function delay(ms) {
	return new Promise(resolve => {
		setTimeout(resolve, ms);
	});
}

function ensure_update_can_continue(database, where) {

	if (database !== current_db) {
		throw new Error(`${where}: database changed unexpectedly`);
	}

	if (abort_flag) {
		throw new Error(`${where}: aborted by user`);
	}
}

async function maybe_yield(database, started_at, where) {

	ensure_update_can_continue(database, where);

	if (Date.now() - started_at < YIELD_AFTER_MS) {
		return started_at;
	}

	await delay(RESUME_DELAY_MS);
	ensure_update_can_continue(database, where);

	return Date.now();
}

async function continue_deletions(database, missing_files, new_files_total) {

	let batch_promises = [];
	let started_at = Date.now();
	let deletions_done = 0;

	if (missing_files.length > 0) {
		update_import_status(0, missing_files.length, 0, new_files_total, "deleting");
	}

	for (let relpath of missing_files) {
		ensure_update_can_continue(database, "continue_deletions()");
		batch_promises.push(database(`deleteone ${JSON.stringify({relpath: relpath})}`));

		if (batch_promises.length >= DELETION_BATCH_SIZE) {
			await Promise.all(batch_promises);
			deletions_done += batch_promises.length;
			update_import_status(deletions_done, missing_files.length, 0, new_files_total, "deleting");
			batch_promises = [];
			started_at = await maybe_yield(database, started_at, "continue_deletions()");
		}
	}

	if (batch_promises.length > 0) {
		await Promise.all(batch_promises);
		deletions_done += batch_promises.length;
		update_import_status(deletions_done, missing_files.length, 0, new_files_total, "deleting");
	}
}

async function continue_additions(database, archivepath, missing_files_total, new_files, new_records) {

	let batch_promises = [];
	let started_at = Date.now();
	let additions_done = 0;

	if (new_files.length > 0) {
		update_import_status(missing_files_total, missing_files_total, 0, new_files.length, "adding");
	}

	for (let relpath of new_files) {
		ensure_update_can_continue(database, "continue_additions()");

		let record = create_record_from_path(archivepath, relpath);
		batch_promises.push(database(`add ${JSON.stringify(record)}`));
		new_records.push(record);

		if (batch_promises.length >= ADDITION_BATCH_SIZE || Date.now() - started_at >= YIELD_AFTER_MS) {
			await Promise.all(batch_promises);
			additions_done += batch_promises.length;
			update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length, "adding");
			batch_promises = [];
			started_at = await maybe_yield(database, started_at, "continue_additions()");
		}
	}

	if (batch_promises.length > 0) {
		await Promise.all(batch_promises);
		additions_done += batch_promises.length;
		update_import_status(missing_files_total, missing_files_total, additions_done, new_files.length, "adding");
	}
}

async function continue_update(database, archivepath, missing_files, new_files, new_records) {

	ensure_update_can_continue(database, "continue_update()");

	await continue_deletions(database, missing_files, new_files.length);
	await continue_additions(database, archivepath, missing_files.length, new_files, new_records);

	if (missing_files.length > 0 || new_files.length > 0) {
		update_import_status(missing_files.length, missing_files.length, new_files.length, new_files.length, "saving");
		await database("save");
	}
}

exports.current = function() {
	return current_db;
};

exports.wip = function() {
	return work_in_progress;
};

exports.connect = function() {

	if (work_in_progress) {
		throw new Error("connect() called while work in progress");
	}

	if (current_db) {
		current_db("quit");
		current_db = null;
	}

	if (typeof config.sgfdir !== "string" || !fs.existsSync(config.sgfdir)) {
		config.sgfdir = null;
		return;
	}

	current_db = bridge.new_db();
	let filepath = slashpath.join(config.sgfdir, ".shin-kaya-2.jsonl");

	current_db(`expect ["relpath", "dyer", "movecount", "SZ", "HA", "PB", "PW", "BR", "WR", "RE", "DT", "EV", "RO"]`);
	current_db(`load ${filepath}`);
	current_db(`sort "relpath"`);
};

exports.update = function() {

	if (!current_db) {
		return Promise.reject(new Error("update(): No database."));
	}

	if (work_in_progress) {
		return Promise.reject(new Error("update(): Work is in progress."));
	}

	work_in_progress = true;
	abort_flag = false;

	let database = current_db;
	let archivepath = config.sgfdir;
	let missing_files = [];
	let new_files = [];
	let new_records = [];

	return Promise.all
	(
		[
			list_all_files(archivepath, ""),
			database("select {}"),
		]
	)

	.then(foo => {

		let [files, records] = foo;

		let db_set = Object.create(null);
		let file_set = Object.create(null);

		for (let f of files) {
			file_set[f] = true;
		}

		for (let o of records) {
			db_set[o.relpath] = true;
		}

		// Make the diffs...

		for (let key of Object.keys(db_set)) {
			if (!file_set[key]) {
				missing_files.push(key);
			}
		}
		for (let key of Object.keys(file_set)) {
			if (!db_set[key]) {
				new_files.push(key);
			}
		}

		update_import_status(0, missing_files.length, 0, new_files.length, "starting");
		return continue_update(database, archivepath, missing_files, new_files, new_records);

	})

	.then(() => {
		return {additions: new_files.length, deletions: missing_files.length, new_records: new_records}
	})

	.finally(() => {
		work_in_progress = false;
		abort_flag = false;
	});

};

exports.stop_update = function() {
	if (work_in_progress) {
		abort_flag = true;
	}
};
