"use strict";

const fs = require("fs");

const bridge = require("./db_bridge");
const slashpath = require("./slashpath");

const { list_all_files } = require("./walk_promises");
const { create_record_from_path } = require("./records");

const DELETION_BATCH_SIZE = 43;
const ADDITION_BATCH_SIZE = 47;

let current_db = null;
let work_in_progress = false;
let abort_flag = false;

// ------------------------------------------------------------------------------------------------

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
		missing_files.sort();
		for (let key of Object.keys(file_set)) {
			if (!db_set[key]) {
				new_files.push(key);
			}
		}

		return perform_deletions(database, missing_files, new_files.length);

	})

	.then(() => {

		return perform_additions(database, archivepath, missing_files.length, new_files, new_records);

	})

	.then(() => {

		throw_if_cannot_continue(database);			// Before we save.

		if (missing_files.length > 0 || new_files.length > 0) {
			update_import_status(missing_files.length, missing_files.length, new_files.length, new_files.length, "saving");
			return database("save");
		} else {
			return;
		}
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

// ------------------------------------------------------------------------------------------------

async function perform_deletions(database, missing_files, new_files_total) {

	let batch_promises = [];
	let deletions_done = 0;

	if (missing_files.length > 0) {
		update_import_status(0, missing_files.length, 0, new_files_total, "deleting");
	}

	for (let relpath of missing_files) {

		batch_promises.push(database(`deleteone ${JSON.stringify({relpath: relpath})}`));

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
		batch_promises.push(database(`add ${JSON.stringify(record)}`));
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

// ------------------------------------------------------------------------------------------------

function throw_if_cannot_continue(database) {
	if (database !== current_db) {
		throw new Error(`database changed unexpectedly`);
	}
	if (abort_flag) {
		throw new Error(`aborted by user`);
	}
}

// ------------------------------------------------------------------------------------------------

function update_status(msg) {
	let el = document.getElementById("status");
	if (el) {
		el.innerHTML = msg;
	}
}

function update_import_status(deletions_done, deletions_total, additions_done, additions_total, phase) {
	update_status(`Updating database (${phase}) - deletions: ${deletions_done}/${deletions_total}, additions: ${additions_done}/${additions_total}`);
}
